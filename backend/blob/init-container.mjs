// Creates the private blob containers for student work and mark schemes. Local-dev
// equivalent of `npm run db:init` for the SQL schema — except there's no
// separate DDL to apply, container creation is the entire "schema" (see the
// container-vs-container discussion: a blob container has no columns, no
// folders, just a name and an access level).
//
// Run after `docker compose up -d azurite`:
//     npm run blob:init
import { BlobServiceClient } from '@azure/storage-blob'
import config from '../src/config/index.js'

if (!config.AZURE_STORAGE_CONNECTION_STRING) {
    throw new Error(
        'AZURE_STORAGE_CONNECTION_STRING is not set. This script is for the ' +
        'local docker-compose Azurite container only, never for Azure — set ' +
        'it in .env first (see .env.example).'
    )
}

const CONTAINER_NAMES = ['student-work', 'mark-schemes']

// Local dev only — the frontend origin allowed to PUT straight to blob
// storage using a SAS URL (see src/services/blobService.js). Azure Storage
// (Azurite included) ships with zero CORS rules by default, so without
// this the browser blocks the upload with a CORS error before it ever
// reaches Azurite — this isn't optional for the direct-to-blob flow to work.
const FRONTEND_ORIGIN = 'http://localhost:5173'

async function main() {
    const blobServiceClient = BlobServiceClient.fromConnectionString(config.AZURE_STORAGE_CONNECTION_STRING)
    for (const name of CONTAINER_NAMES) {
        // No access option: both containers remain private.
        const { succeeded } = await blobServiceClient.getContainerClient(name).createIfNotExists()
        console.log(succeeded
            ? `Created private container "${name}".`
            : `Container "${name}" already exists — nothing to do.`)
    }

    // setProperties() replaces the whole properties set, not a per-field
    // patch — fine here since this account has nothing else configured
    // (no logging/metrics/static website) to preserve.
    await blobServiceClient.setProperties({
        cors: [{
            allowedOrigins: FRONTEND_ORIGIN,
            allowedMethods: 'PUT',
            allowedHeaders: 'x-ms-blob-type,content-type',
            exposedHeaders: '*',
            maxAgeInSeconds: 3600,
        }],
    })
    console.log(`CORS configured — ${FRONTEND_ORIGIN} may PUT directly to blob storage.`)
}

main().catch((err) => {
    console.error('Failed to initialise blob container:', err)
    process.exit(1)
})
