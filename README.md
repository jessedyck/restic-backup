# Automatic macOS Restic backups using launchctl or cron

## Description

This script will run a backup to a supplied Minio server, forget/prune old backups according to the policy in the script, log and optionally send a desktop notification using [terminal-notifier](https://github.com/julienXX/terminal-notifier) if installed.

Note, you can use any of the supported [storage backends](https://restic.readthedocs.io/en/latest/030_preparing_a_new_repo.html). The setup should be similar but you will have to use other configuration variables to match your backend of choice.

This script was put together by combining and modifying a few scripts, mainly [restic-systemd-automatic-backup](https://github.com/erikw/restic-systemd-automatic-backup) and [borg-s3-home-backup](https://github.com/luispabon/borg-s3-home-backup).

## Set up

### Install and create a Minio backend

First, see this [official Minio + Restic tutorial](https://docs.minio.io/docs/restic-with-minio) on restic.

I use this [Minio ARM Docker container](https://github.com/jessedyck/minio-arm) running on a local RaspberryPi. I run it with the access key and secret passed into the container using the -e flags. See the `Dockerfile` head comments for an example.

Take note of the your access key and secret for the next steps.

Create a new bucket on your server by browsing to http://<local-ip>:9000 and logging in with your access key and secret.

### (Optional) Install terminal-notifier
```bash
brew install terminal-notifier
```

### Configure environment variables locally

#### Generate a passphrase
Using a passphrase stored in the macOS Keychain seems like the most secure option to me. Be sure to store it in another secure location as well.
```bash
security add-generic-password -D secret -a $USER -s restic-passphrase -w $(head -c 1024 /dev/urandom | base64)
```

#### Retreive the passphrase and store it elsewhere
Make sure the passphrase is accesssible without access to the computer in question. Otherwise your backup is **useless**.
```bash
security find-generic-password -a $USER -s restic-passphrase -w
```

#### Export configuration variables
```bash
export RESTIC_REPOSITORY="s3:http://10.0.1.9:9000/jesse-mbp"
export AWS_ACCESS_KEY_ID="xxxxxx"
export AWS_SECRET_ACCESS_KEY="xxxxxx"
export RESTIC_PASSWORD="security find-generic-password -a $USER -s restic-passphrase -w"
```

### Initialize remote repo
Now we must initialize the repository on the remote end:
```bash
restic init
```

### Get the backup script
Clone this repo into your Home folder
```bash
cd ~ && git clone https://github.com/jessedyck/restic-backup && cd restic-backup
```

#### Files:
* `restic_backup.sh`: A script that defines how to run the backup. Edit this file to respect your needs in terms of backup which paths to backup, retention (number of backups to save), etc.
* `.backup_exclude`: A list of file pattern paths to exclude from you backups, files that just occupy storage space, backup-time, network and money.


## Run a Backup
### Make first backup
Now see if the backup itself works, by running:

```bash
chmod +x ./restic_backup.sh
./restic_backup.sh
```
### Get snapshots
Verify a recent snapshop exists
```bash
restic snapshots
```

## Automation 

#### Launchctl

TODO

#### Cron
TODO

### (Recommended) Automated backup checks
TODO
