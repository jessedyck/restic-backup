# Automatic Restic backups on macOS and Linux

**Don't use this!** Still a work in progress.

## Description
Automated backups to a Minio server using Restic and Node.js, sending desktop notifications on completion and failure. The script will forget/prune old backups according to the defined policy, and outputs status to a log file.

This script started from [restic-systemd-automatic-backup](https://github.com/erikw/restic-systemd-automatic-backup) and [borg-s3-home-backup](https://github.com/luispabon/borg-s3-home-backup), then morphed into a separate NodeJS script for logic outside of the shell.

## Files:
* **restic_backup.js**: A script that defines how to run the backup. Edit this file to respect your needs in terms of backup which paths to backup, retention (number of backups to save), etc.
* **.backup_exclude**: A list of file pattern paths to exclude from you backups, files that just occupy storage space, backup-time, network and money. Note that on macOS, the script will read in Time Machine's default user profile excludes automatically.
* **config.example.json**: Example config file, meant to be renamed and edited, so that future pulls from github won't overwrite the config.
* **me.jessedyck.restic-backup.plist**: launchctl schedule file, to be copied to _~/Library/LaunchAgents_

## Set up

### Install and create a Minio backend
First, see this [official Minio + Restic tutorial](https://docs.minio.io/docs/restic-with-minio) in the Minio docs.

I use my own [Minio ARM Docker container](https://github.com/jessedyck/minio-arm) running on a local Raspberry Pi. I run it with the access key and secret passed into the container using the -e flags. See the `Dockerfile` head comments for an example.

Take note of the your access key and secret for the next steps.

Create a new bucket on your server by browsing to http://<local-ip>:9000 and logging in with your access key and secret.

### Get the backup script
Install via NPM:
```bash
npm install jessedyck/restic-backup
```

### Create config file
Rename or copy config.example.json, then open the file and update the properties as needed. This allows for scheduling without a complicated environment setup.

### Set up a Passphrase

#### macOS
Using a passphrase stored in the macOS Keychain seems like the most secure option to me, rather than keeping it in the plain-text config file:

```bash
security add-generic-password -D secret -a $USER -s restic-passphrase -w $(head -c 1024 /dev/urandom | base64)
```

Reteive the passphrase and **store it somewhere safe**, along with your AWS Access Key and Secret; if you don't have access to these details when your computer is down, your backup is **useless**.

```bash
security find-generic-password -a $USER -s restic-passphrase -w
```

#### Linux
Supply a (securely generated and stored) passphrase through the config file, setting `"passwordFrom": "string"` as well.

```bash
"passwordFrom": "string",
"resticPassword": "Passw0rd",
```

#### resticRepository (required)
The fully-qualified path to the repository, including the repo-type itentifier. 

Example:
`s3:http://10.0.1.1:9000/repo`

#### AWSAccessKeyID (required)
Minio's acccess key from the previous step.

#### AWSSecretAccessKey (required)
Minio's secret key from the previous step.

#### passwordFrom
Possible values:
* **keychain** for the macOS keychain. Looks for `restic-passphrase` in the current user account.
* **string** doesn't actually have meaning, but implies the `resticPassword` property will be used.

TODO: Add more keystores for different platforms.

#### resticPassword
The password used to encrypt the repo. This value is **not recommended**, since it's stored as plain text. If a value `passwordFrom` option is set, this value is ignored.

#### includePaths
An array of paths to include in the backup. Can use ~/ to represent the user's home folder, this will be replaced at runtime. All paths must be valid otherwise execution stops.

#### excludePaths
An array of paths to exclude _from the included paths_. Automatically pulls in known-exclusions for certain platforms (only Time Machine at the moment). Can use ~/ and all paths must be valid (same as `includePaths`).

#### retention
How many hourly, daily, weekly, monthly and yearly backups to keep, and when to run a cleanup.

### Initialize remote repo
Now we must initialize the repository on the remote end:
```bash
# This first one will fail, but is the easiest way to set up the environment for init
node ./restic_backup.js
restic init
```

## Make first backup
Now see if the backup itself works, by running:

```bash
node ./restic_backup.js
```

### Get snapshots
Verify a recent snapshop exists using restic directly.
```bash
restic snapshots
```

## Automation 

### Launchctl
To keep the script simple, this isn't done automatically (anymore). **Copy the included plist** file to _~/Library/LaunchAgents_.

### Cron
Schedule as root to ensure the script has permissions to access all user accounts needed.

```bash
sudo crontab -e
# Schedule for 2am daily
0 2 * * * /home/jessedyck/backup.sh
```

### (Recommended) Automated backup checks
TODO