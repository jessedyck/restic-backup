#!/usr/bin/env node
// Backup folder using Restic to a Minio server.
// All Minio variables are sent via environment variables.
// Output is logged and notifications sent (when notification system is available)
//
// Runs on macOS and Linux.


// ********
// CONFIGURATION OPTIONS

// How many backups to keep
const retention = {
    hours: 48,
    days: 14,
    weeks: 16,
    months: 18,
    years: 3,
    purgeAfterNthBackup: 10 // How frequently to run the (intensive) purge/cleanup job 
}

// Default backup location: User's home directory
const backupPath = process.env.HOME + "/";

// .backup_exclude in the user's home directory is a line-separated list of files to exclude
var backupExcludes = "--exclude-file " + process.env.HOME + "/.backup_exclude";

// Directory to store logs and state
const backupDir = process.env.HOME + '/.restic';


// STOP EDITING
// ********

const https = require('https');
const util = require('util');
const cp = require('child_process');
const exec = util.promisify(cp.exec);
const notifier = require('node-notifier');
const fs = require('fs');
const plist = require('fast-plist');

const minNodeVersion = 'v10.8.0';
const backupLogfile = backupDir + '/backup.log';
const backupStatefile = backupDir + '/state.json';
const backupDate = new Date();
const backupTag = 'home-main';
var   backupState;

// Check min node version
if (!process.version >= minNodeVersion) {
    maybe_notify (`Minimum Node version required is ${minNodeVersion}`);
    process.exit(1);
}

// Set up and check environment variables
if ( !process.env.RESTIC_REPOSITORY || 
    !process.env.AWS_ACCESS_KEY_ID ||
    !process.env.AWS_SECRET_ACCESS_KEY ) {
        maybe_notify ("Please export RESTIC_REPOSITORY, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY", "Backup Configuration")
        process.exit(1);
}

if (!process.env.RESTIC_PASSWORD) {
    maybe_notify ("Please export RESTIC_PASSWORD", "Backup Configuration")
    process.exit(1);
}

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
/**
 * @returns {Sting} Current version of Restic installed (directly from `restic version`)
 */
async function getInstalledVersion () {
    const { stdout, stderr } = await exec('restic version');
    
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
 * @returns {Array} List of paths to exclude from backup
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

async function runPruneAndCheck () {
    let pruneStart, checkStart;
 
    // Keeping this all in a promise chain simplifies error handling
    return exec(`restic forget --tag ${backupTag} --keep-hourly ${retention.hours} --keep-daily ${retention.days} --keep-weekly ${retention.weeks} --keep-monthly ${retention.months} --keep-yearly ${retention.years}`)
        .then ( () => {
            pruneStart = new Date;
            logger('Starting prune');
            return execCmdWithStdout(`restic prune`);
        })
        .then ( () => {
            backupState.lastKnownPurge = (new Date()).toISOString();
            updateState(backupState);

            logger (`Prune completed in ${dateDiff(pruneStart, new Date())}.`)

            checkStart = new Date;
            return execCmdWithStdout(`restic check`)
        })
        .then ( () => {
            maybe_notify (`✅👌 Maintenance completed`, 'Backup Maintenance')
            
            backupState.lastKnownCheck = (new Date()).toISOString();
            backupStatebackupsSinceLastKnownPurge = 0;
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

    // Create ~/.restic (if doesn't exist)
    if (!fs.existsSync(backupDir)) {
        try {
            fs.mkdirSync(backupDir);
        } catch (e) {
            maybe_notify(`Could not create local directory: ${backupDir}`)
            return Promise.reject(e);
        }
    }

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
        const platformExcludes = getUserExcludesForPlatform();
        if (platformExcludes.length > 0)
            backupExcludes += ' --exclude ' + platformExcludes.join(' --exclude ');

        const backupJobHadNonfatalError = await execCmdWithStdout(`restic backup --tag ${backupTag} --verbose ${backupExcludes} ${backupPath}`);

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
    if (backupState.backupsSinceLastKnownPurge >= retention.purgeAfterNthBackup) {
        maybe_notify(`This will take a while.`, 'Starting Backup Maintenance')
        
        try {
            await runPruneAndCheck();
        } catch (e) {
            
        }
    } else {
        logger(`Skipping backup maintenance. Policy: ${retention.purgeAfterNthBackup} Current: ${backupState.backupsSinceLastKnownPurge}.`)
    }

    return Promise.resolve();
}

main ()
.finally ( () => {
    logger(`Finished backup in ${dateDiff(backupDate, new Date())}`);
    fs.appendFile(backupLogfile, `************\n`, () => {} );
})