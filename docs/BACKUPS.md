# Encrypted USB backups

Backups are optional and disabled by default.

## Enable

1. Connect a writable USB drive.
2. Open **Settings → Backup**.
3. Enter the destination folder.
4. Create a recovery password of at least ten characters.
5. Select **Enable backups**.
6. Use **Back up now** for the first test.

The recovery password is separate from the phone PIN. Store it in a password
manager. It cannot be recovered from the backup.

Automatic backups run once per configured day and retain the newest configured
number of bundles. They contain:

- the SQLite database;
- all application settings;
- pantry, shopping, reminder, timer, calendar-cache, and product-cache data;
- encrypted Apple credentials;
- remote access configuration; and
- the device key required to decrypt restored secrets.

The complete bundle is encrypted with AES-GCM. Its encryption key is derived
from the recovery password using scrypt.

## Restore on a fresh installation

1. Install the dashboard normally on the replacement SD card.
2. Connect the backup USB drive before finishing first-run setup.
3. On the first wizard screen, select **Find backups on connected USB drives**.
4. Select the desired `.hdbak` file.
5. Enter its recovery password.
6. Select **Restore and restart**.

The application validates the encryption tag, manifest, required files, and
SQLite integrity before replacing the new database. It retains a
`dashboard.pre-restore.db` safety copy.

After restart, verify iCloud synchronization, scanner selection, GPIO settings,
and the backup mount path. Linux device paths or USB mount names may differ on
replacement hardware.
