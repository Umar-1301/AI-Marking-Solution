export default {
    PORT: process.env.PORT || 3001,
    FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:5173',
    AI_SERVICE_URL: process.env.AI_SERVICE_URL || 'http://localhost:8000',
    JWT_SECRET: (() => {
        if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is not set')
        return process.env.JWT_SECRET
    })(),
    PASSWORD_PEPPER: (() => {
        if (!process.env.PASSWORD_PEPPER) throw new Error('PASSWORD_PEPPER environment variable is not set')
        return process.env.PASSWORD_PEPPER
    })(),
    EMAIL_PEPPER: (() => {
        if (!process.env.EMAIL_PEPPER) throw new Error('EMAIL_PEPPER environment variable is not set')
        return process.env.EMAIL_PEPPER
    })(),
    // Azure SQL Database connection target. The app authenticates with an Entra
    // managed identity ('Active Directory Default'), so there is NO password or
    // connection string secret — only the server host and database name. Both are
    // REQUIRED (no hardcoded default): the target is 100% env-driven, so changing
    // server/database is a config change, never a code change, and a missing value
    // fails loudly at startup instead of silently pointing at the wrong database.
    // The mssql config object is assembled in db/index.js. Together these form the
    // ADO.NET string: Server=tcp:<SQL_SERVER>,1433;Initial Catalog=<SQL_DATABASE>;...
    SQL_SERVER: (() => {
        if (!process.env.SQL_SERVER) throw new Error('SQL_SERVER environment variable is not set')
        return process.env.SQL_SERVER
    })(),
    SQL_DATABASE: (() => {
        if (!process.env.SQL_DATABASE) throw new Error('SQL_DATABASE environment variable is not set')
        return process.env.SQL_DATABASE
    })(),
    // Local-only alternative to the Entra ID path above: set both to use SQL
    // authentication against the docker-compose SQL Server container instead
    // (see docker-compose.yml and backend/db/apply-schema.mjs). Optional, not
    // required like SQL_SERVER/SQL_DATABASE above — production never sets
    // these, so db/index.js always falls through to Entra ID there, unchanged.
    SQL_USER: process.env.SQL_USER || null,
    SQL_PASSWORD: process.env.SQL_PASSWORD || null,
    // Blob storage target for student work uploads. Local-only: Azurite's
    // well-known dev connection string (see docker-compose.yml's azurite
    // service). Azurite cannot do Entra ID at all, so local development has
    // no choice but the account-key connection string. Optional, not
    // required — unset falls through to the managed-identity path below.
    AZURE_STORAGE_CONNECTION_STRING: process.env.AZURE_STORAGE_CONNECTION_STRING || null,
    // Production path — the account URL only, NOT a secret. The container
    // authenticates with its Entra managed identity via
    // DefaultAzureCredential (same approach as SQL_SERVER above, which
    // likewise carries only a hostname and no credential), so there is no
    // key or connection string to store, rotate, or leak. Format:
    // https://<account>.blob.core.windows.net
    AZURE_STORAGE_ACCOUNT_URL: process.env.AZURE_STORAGE_ACCOUNT_URL || null,
    // Service Bus target for the marking queue. Local-only: the emulator's
    // fixed development connection string (see docker-compose.yml's
    // servicebus-emulator). The emulator cannot do Entra ID at all, so local
    // development has no choice but this connection string. Optional, not
    // required — unset falls through to the managed-identity path below.
    AZURE_SERVICEBUS_CONNECTION_STRING: process.env.AZURE_SERVICEBUS_CONNECTION_STRING || null,
    // Production path — the namespace hostname only, NOT a secret. Same
    // managed-identity reasoning as AZURE_STORAGE_ACCOUNT_URL above.
    // Format: <namespace>.servicebus.windows.net (no scheme — the SDK
    // takes a bare fully-qualified namespace here, unlike blob's full URL)
    AZURE_SERVICEBUS_NAMESPACE: process.env.AZURE_SERVICEBUS_NAMESPACE || null,
    MAX_FILE_SIZE_MB: 5,
    MAX_PDF_PAGES: 30,
    ALLOWED_MIME_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'],
}
