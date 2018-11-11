#!/usr/bin/env node
// Backup folder using Restic to a Minio server.
// All Minio variables are sent via environment variables.
// Output is logged and notifications sent (when notification system is available)
//
// Runs on macOS
// TODO: Windows + Linux version


const https = require('https');
const util = require('util');
const cp = require('child_process');
const exec = util.promisify(cp.exec);
const notifier = require('node-notifier');
const fs = require('fs');
const plist = require('fast-plist');

const minNodeVersion = 'v10.8.0';

// Directory to store logs and state
const backupLogfile = './backup.log';
const backupStatefile = './state.json';
const backupDate = new Date();
const backupTag = 'home-main';
var   backupState;
var   resticBin;

// Check min node version
if (!process.version >= minNodeVersion) {
    maybe_notify (`Minimum Node version required is ${minNodeVersion}`);
    process.exit(1);
}

// Find restic binary
if (fs.existsSync('/usr/local/bin/restic')) {
    resticBin = '/usr/local/bin/restic';
} else if (typeof resticBin == 'undefined' && fs.existsSync('restic')) {
    resticBin = fs.realpathSync('restic');
} else {
    maybe_notify ("Restic cannot be found in current directory or /usr/local/bin.", "Backup Configuration")
    process.exit(1);
}
logger (`Found restic binary in ${resticBin}`);

// UTILITY FUNCTIONS

/**
 * Promisify https.get()
 * @link https://gist.github.com/krnlde/797e5e0a6f12cc9bd563123756fc101f
 **/
https.get[util.promisify.custom] = function getAsync(options) {
    return new Promise((resolve, reject) => {
        https.get(options, (response) => {
            response.end = new Promise((resolve) => response.on('end', resolve));
            resolve(response);
        }).on('error', reject);
    });
};
const get = util.promisify(https.get);

/**
 * Sends a desktop notification via the default notification system.
 * Also logs the same message via logger() function.
 * 
 * @param {String} message The message to display
 * @param {String} title The title of the message
 */
function maybe_notify(message, title) {
    notifier.notify ( {
        title: title,
        message: message,
    });
    logger(`${title}: ${message}`);
}

/**
 * Sends a message or object to the console, as well as writes to a 
 * log file, along with the date/time stamp of message.
 * @param {mixed} message Either a string or object to be logged
*/
function logger (message) {
    const date = (new Date()).toISOString();
    // child_process.exec.on.stdout likes to append a trailing \n.
    // Also want each log entry on it's own line.
    if (typeof message == 'string')
        message = message.replace(/\n/g, '   ');

    console.log(message);

    fs.appendFile(backupLogfile, `${date}\t ${message}\n`, (err) => { 
        if (typeof err == Error ) {
            logger(err)
            throw new Error(err)
        }
    });
}

/**
 * Returns the minutes (if greater than 120 seconds) or seconds between two dates.
 * @param {Date} d1
 * @param {Date} d2
 * @returns {string}
*/
function dateDiff(d1, d2) {
    let diff = d2 - d1
    
    if ( diff / 1000 > 120)
        return Math.round(diff / 1000 / 60) + ' minutes';
    
    return Math.round(diff / 1000)  + ' seconds';
}


// FUNCTIONS
async function getConfig () {
    var config;
    
    // Read config file from local directory - exit if fails
    try {
        let configFile = fs.readFileSync('./config.json');
        config = JSON.parse(configFile);
    } catch (e) {
        maybe_notify(`Could not load config file or invalid config file.`, "Backup Configuration");
        logger(e);
        process.exit(1);
    }

    // Check each config property and track any in error.
    // Wait until the end to exit with a list of all incorrect properties.
    let configError = [];

    if (!typeof config.resticRepository == 'string' || config.resticRepository == '')
        configError.push('resticRepository');

    if (!typeof config.AWSAccessKeyID == 'string' || config.AWSAccessKeyID == '')
        configError.push('AWSAccessKeyID');

    if (!typeof config.AWSSecretAccessKey == 'string' || config.AWSSecretAccessKey == '')
        configError.push('AWSSecretAccessKey');

    // If passwordFrom is set, run the appropriate commands to get
    // the value from the specified store.
    // Note: This means the password that may be set in the config is overwritten.
    //
    // TODO: Add additional passwordFrom values for other key-store systems
    switch (config.passwordFrom) {
        case 'keychain':
            try {
                let passBuffer = cp.execSync(`security find-generic-password -a ${process.env.USER} -s restic-passphrase -w`);

                // The returned value from execSync has a trailing line-break, so trim it in toString().
                config.resticPassword = passBuffer.toString('utf8', 0, passBuffer.length-1);
            } catch (e) {
                maybe_notify(`Could not retrieve password from keychain.`, "Backup Configuration");
                process.exit(1);
            }
        break;
    }

    if (!typeof config.resticPassword == 'string' || config.resticPassword == '')
        configError.push('resticPassword');
    
    if (!typeof config.includePaths == 'array' || !config.includePaths.length > 0)
        configError.push('AWSAccessKeyID');

    // If any properties had an error, exit
    if (configError.length > 0) {
        maybe_notify(`Missing or incorrect configuration value(s) for: ${configError.join(', ')}`, "Backup Configuration");
        process.exit(1);
    }

    // normalize paths - replace ~/ token
    config.includePaths = config.includePaths.map(a => a.replace('~/', process.env.HOME));
    config.excludePaths = config.excludePaths.map(a => a.replace('~/', process.env.HOME));

    // normalize paths - strip empty paths
    config.includePaths = config.includePaths.filter(a => a != '');
    config.excludePaths = config.excludePaths.filter(a => a != '');

    // Test all paths to ensure they exist, otherwise exit
    config.includePaths.forEach(a => {
        if (!fs.existsSync(a)) {
            maybe_notify(`Include path invalid: ${a}`, "Backup Configuration");
            process.exit(1);
        }
    });

    config.excludePaths.forEach(a => {
        if (a != '' && !fs.existsSync(a)) {
            maybe_notify(`Exclude path invalid: ${a}`, "Backup Configuration");
            process.exit(1);
        }
    });

    // Set restic environment variables - appears there's no other way
    // to pass these into the cmd (except repo).
    process.env.RESTIC_REPOSITORY = config.resticRepository;
    process.env.AWS_ACCESS_KEY_ID = config.AWSAccessKeyID;
    process.env.AWS_SECRET_ACCESS_KEY = config.AWSSecretAccessKey;
    process.env.RESTIC_PASSWORD = config.resticPassword;

    // Config checks out - return/resolve promise
    return config;
}

/**
 * @returns {Sting} Current version of Restic installed (directly from `restic version`)
 */
async function getInstalledVersion () {
    const { stdout, stderr } = await exec(`${resticBin} version`);
    
    if (stderr) return Promise.reject(stderr);
    
    logger('Got installed Restic version: ' + stdout);
    return Promise.resolve(stdout);
}

/**
 * @returns {Sting} Name of the latest released version of Restic from githug
 */
async function getLatestVersion () {
    const sourceRepo = 'restic/restic';

    const opt = {
        hostname: 'api.github.com',
        path: `/repos/${sourceRepo}/releases/latest`,
        headers: {
            'User-Agent': `node`
        },
        timeout: 15000 // 15 seconds
    }

    const resp = await get(opt)

    let rawData = '';
    resp.on('data', d => { rawData += d; })
    
    // wait for end event
    await resp.end;

    try {
        const parsedData = JSON.parse(rawData);
        logger(`Got latest Restic version: ${parsedData.name}`);
        return Promise.resolve(parsedData.name);
    } catch (e) {
        return Promise.reject(e.message);
    }
}

/**
 * Retreive or create new local backup state object and file.
 * Mainly used to track when to run the next prune/check operation. 
 * 
 * NOTE: Never assume this exists. Backup should run properly when it doesn't.
 * 
 * @returns {Object} The JSONified object from file, or new instance.
 */
function getBackupState () {
    let defaultState = {
        lastKnownBackup: '',
        lastKnownPurge: (new Date()).toISOString(),
        lastKnownCheck: (new Date()).toISOString(),
        backupsSinceLastKnownPurge: 0
    };

    // Create file if none exists
    try {
        fs.writeFileSync(backupStatefile, '', {flag: 'wx'})
        logger('State file created');

        return defaultState;
    } catch (e) { 
        logger('State file exists');

        let file = fs.readFileSync(backupStatefile);
        file = file.toString();

        try {
            return JSON.parse( file );
        } catch (e) {
            logger ('Invalid state file - resetting to default state.');
            return defaultState;
        }
    }
}

/**
 * Updated a state file.
 * Don't exit on failed state write since backup may still have succeeded.
 * 
 * @param {object} state State to write
 * @see getBackupState for state object template
*/
function updateState (state) {
    try {
        fs.writeFileSync(backupStatefile, JSON.stringify(state));
        logger('Updated state file')
    } catch (e) {
        logger(`*** Error: Could not write to ${backupStatefile}`)
        logger(e)
        hasError = true;
    }
}

/**
 * @returns {Array} List of paths to exclude from backup, or an empty array
 */
function getUserExcludesForPlatform () {
    const platform = process.platform;

    switch (platform) {
        case 'darwin':
            try {
                let file = fs.readFileSync('/System/Library/CoreServices/backupd.bundle/Contents/Resources/StdExclusions.plist').toString();
                file = plist.parse(file);
                let excludes = file.UserPathsExcluded;
                return excludes.map(a => `${process.env.HOME}/${a}`);
            }
            catch (e) {
                logger (`Could not get excludes for platform: ${platform}.`)
                logger (e);
            }
        break;
        default:
            // Return an empty array for easier handling of paths
            return [];
        break;
    }
}

/**
 * Run async command in new promise (rather than promisified exec) so we can use the 
 * event emitter to send progress (stdout/stderr) back to the terminal.
 * 
 * @param {String} cmd A valid terminal command
 * @returns {Promise} Resolves a promise with a boolean indicating if there was non-fatal errors (true)
 */
async function execCmdWithStdout (cmd) {
    let hasNonfatalError = false;

    logger(`Executing command: ${cmd}`)

    return new Promise ( (resolve, reject) => {
        const job = cp.exec(cmd, (status) => {
            if (status == null || status.code === 0) {
                resolve(hasNonfatalError);
            } else {
                reject(`Command failed with error: ${status.toString()}`);
            }
        });

        job.stdout.on('data', (d) => { logger(d) });
        job.stderr.on('data', (d) => { 
            hasNonfatalError = true;
            logger(`*** Error: ${d}`); 
        });
    });
}

async function runPruneAndCheck (config) {
    let pruneStart, checkStart;
 
    // Keeping this all in a promise chain simplifies error handling
    return exec(`${resticBin} forget --tag ${backupTag} --keep-hourly ${config.retention.hours} --keep-daily ${config.retention.days} --keep-weekly ${config.retention.weeks} --keep-monthly ${config.retention.months} --keep-yearly ${config.retention.years}`)
        .then ( () => {
            pruneStart = new Date;
            logger('Starting prune');
            return execCmdWithStdout(`${resticBin} prune`);
        })
        .then ( () => {
            backupState.lastKnownPurge = (new Date()).toISOString();
            updateState(backupState);

            logger (`Prune completed in ${dateDiff(pruneStart, new Date())}.`)

            checkStart = new Date;
            return execCmdWithStdout(`${resticBin} check`)
        })
        .then ( () => {
            maybe_notify (`✅👌 Maintenance completed`, 'Backup Maintenance')
            
            backupState.lastKnownCheck = (new Date()).toISOString();
            backupState.backupsSinceLastKnownPurge = 0;
            updateState(backupState);

            logger (`Check completed in ${dateDiff(checkStart, new Date())}.`)

            return Promise.resolve();
        })
        .catch ( (err) => {
            maybe_notify (`❌⚠️ Maintenance failed! Check the logs.`, 'Backup Maintenance')
            logger(err);
            return Promise.reject(err);
        });
}


// ********
// MAIN FUNCTION
async function main () {

    const config = await getConfig();

    // initialize logging - First line explicitly does not include date stamp for readability
    fs.appendFile(backupLogfile, `************\n`, () => {} );
    logger('Starting backup');

    backupState = getBackupState();

    // Check for Restic updates
    const installedVersion = await getInstalledVersion();
    const latestVersion = await getLatestVersion();

    if (installedVersion.indexOf(latestVersion) !== 0) {
        maybe_notify(`New version of Restic is available: ${latestVersion}\nYou have: ${installedVersion}`, 'Restic Update Available');
    }

    // Try to run the backup job
    try {

        // Create a string of excludes
        let backupExcludes = ' --exclude-file ./.backup_exclude';

        if (config.excludePaths.length > 0)
            backupExcludes += ` --exclude "${config.excludePaths.join('" --exclude "')}"`;

        let platformExcludes = getUserExcludesForPlatform();
        if (platformExcludes.length > 0)
            backupExcludes += ` --exclude "${platformExcludes.join('" --exclude "')}"`

        let backupJobHadNonfatalError = await execCmdWithStdout(`${resticBin} backup --tag ${backupTag} --verbose ${backupExcludes} "${config.includePaths.join('" "')}"`);

        // Update state then write it out the file
        backupState.lastKnownBackup = backupDate;
        backupState.backupsSinceLastKnownPurge = backupState.backupsSinceLastKnownPurge + 1;
        updateState(backupState);
        
        if (backupJobHadNonfatalError) {
            maybe_notify(`✅👌 Backup completed in ${dateDiff(backupDate, new Date())} with errors.`, 'Backup Job')

            // Only relevant when running in terminal
            console.log(`Check logs for errors: ${backupLogfile}`)
        } else {
            maybe_notify(`✅👌 Backup was successful in ${dateDiff(backupDate, new Date())}.`, 'Backup Job')
        }
    } catch (e) {
        maybe_notify (`❌⚠️ Failed`, 'Backup Job');
        logger(`Backup failed with error: ${e}`);
        return;
    }

    // Backup maintanence.
    // Decided to do this based on # of successful backups and not 'days since backup',
    // since the latter could prune after (for example) 7 days, even if there was 
    // only 1 backup in between those days. It would waste CPU and leaves fewer backups. 
    if (backupState.backupsSinceLastKnownPurge >= config.retention.purgeAfterNthBackup) {
        maybe_notify(`This will take a while.`, 'Starting Backup Maintenance')
        
        try {
            await runPruneAndCheck(config);
        } catch (e) {
            
        }
    } else {
        logger(`Skipping backup maintenance. Policy: ${config.retention.purgeAfterNthBackup} Current: ${backupState.backupsSinceLastKnownPurge}.`)
    }

    return Promise.resolve();
}

main ()
.finally ( () => {
    logger(`Finished backup in ${dateDiff(backupDate, new Date())}`);
    fs.appendFile(backupLogfile, `************\n`, () => {} );
})