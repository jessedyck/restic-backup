#!/usr/bin/env bash
# Backup home folder using Restic to a Minio server.
# All Minio variables are sent via environment variables.
# Output is logged and sent via terminal-notifier (`brew install terminal-notifier`)

# ********
# CONFIGURATION OPTIONS

# How many backups to keep.
RETENTION_HOURS=48
RETENTION_DAYS=14
RETENTION_WEEKS=16
RETENTION_MONTHS=18
RETENTION_YEARS=3

# What to backup, and what to not
BACKUP_PATHS=~/
BACKUP_EXCLUDES="--exclude-file ./.backup_exclude --exclude-file ~/.backup_exclude"
BACKUP_TAG=home-$(date +%Y-%m-%dT%H.%M)


# STOP EDITING
# ********

# Redirect stdout ( > ) into a named pipe ( >() ) running "tee" to a file, so we can observe the status by simply tailing the log file.
me=$(basename "$0")
now=$(date +%F_%R)
log_dir=~/.restic_logs
log_file="${log_dir}/${now}_${me}.$$.log"
test -d $log_dir || mkdir -p $log_dir
exec > >(tee -i $log_file) 2>&1

# Clean up lock if we are killed.
# If killed by systemd, like $(systemctl stop restic), then it kills the whole cgroup and all it's subprocesses.
# However if we kill this script ourselves, we need this trap that kills all subprocesses manually.
exit_hook() {
	echo "In exit_hook(), being killed" >&2
	jobs -p | xargs kill
	restic unlock
}
trap exit_hook INT TERM

function maybe_notify() {
	MESSAGE=$1
	TITLE=$2

	if hash terminal-notifier 2>/dev/null; then
		terminal-notifier -group resticbackup -title "${TITLE}" -message "${MESSAGE}"
	fi

	printf "${TITLE}: ${MESSAGE}\n"
}

# Check environment vars are set
if [[ ! "$RESTIC_REPOSITORY" ]]; then
	maybe_notify "Please export RESTIC_REPOSITORY" "Backup Configuration"
	exit 1
fi

if [[ ! "$AWS_ACCESS_KEY_ID" ]]; then
	maybe_notify "Please export AWS_ACCESS_KEY_ID" "Backup Configuration"
	exit 1
fi

if [[ ! "$AWS_SECRET_ACCESS_KEY" ]]; then
	maybe_notify "Please export AWS_SECRET_ACCESS_KEY" "Backup Configuration"
	exit 1
fi

# Create backup password with:
#	security add-generic-password -D secret -a $USER -s restic-passphrase -w $(head -c 1024 /dev/urandom | base64)
# Now export the password.
# Be sure to grab the new password from Keychain Access and store it somewhere else safe. 
export RESTIC_PASSWORD="security find-generic-password -a $USER -s restic-passphrase -w"

if [[ ! "$RESTIC_PASSWORD" ]]; then
	maybe_notify "Please export RESTIC_PASSWORD" "Backup Configuration"
	exit 1
fi


# NOTE start all commands in background and wait for them to finish.
# Reason: bash ignores any signals while child process is executing and thus my trap exit hook is not triggered.
# However if put in subprocesses, wait(1) waits until the process finishes OR signal is received.
# Reference: https://unix.stackexchange.com/questions/146756/forward-sigterm-to-child-in-bash

# Remove locks from other stale processes to keep the automated backup running.
restic unlock &
wait $!

# Do the backup!
# See restic-backup(1) or http://restic.readthedocs.io/en/latest/040_backup.html
# --one-file-system makes sure we only backup exactly those mounted file systems specified in $BACKUP_PATHS, and thus not directories like /dev, /sys etc.
# --tag lets us reference these backups later when doing restic-forget.
restic backup \
	--tag $BACKUP_TAG \
	--verbose \
	$BACKUP_EXCLUDES \
	$BACKUP_PATHS &
wait $!

OPERATION_STATUS=$?

if [ $OPERATION_STATUS == 0 ]; then
	maybe_notify "✅👌  (${BACKUP_TAG})" "Backup Job"
else
	maybe_notify "❌⚠️   (${BACKUP_TAG})" "Backup Job"
fi

# Bail if backup didn't succeed so we don't run forget/prune
if [ $OPERATION_STATUS -ne 0 ]; then
	exit 1
fi

# Dereference old backups.
# See restic-forget(1) or http://restic.readthedocs.io/en/latest/060_forget.html
restic forget \
	--tag $BACKUP_TAG \
	--keep-hourly $RETENTION_HOURS \
	--keep-daily $RETENTION_DAYS \
	--keep-weekly $RETENTION_WEEKS \
	--keep-monthly $RETENTION_MONTHS \
	--keep-yearly $RETENTION_YEARS &
wait $!

# Log forget status
OPERATION_STATUS=$?

# Remove old data not linked anymore.
# See restic-prune(1) or http://restic.readthedocs.io/en/latest/060_forget.html
restic prune &
wait $!

# Check for errors in either forget or prune command
if [ $OPERATION_STATUS == 0 -a $? == 0 ]; then
	maybe_notify "✅👌  (${BACKUP_TAG})" "Backup Maintenance"
else
	maybe_notify "❌⚠️  (${BACKUP_TAG}). Manually re-run `forget` and `prune`" "Backup Maintenance"
fi

# Check repository for errors.
# NOTE this takes much time (and data transfer from remote repo?), do this in a separate systemd.timer which is run less often.
#restic check &
#wait $!

echo "Backup & cleaning is done."