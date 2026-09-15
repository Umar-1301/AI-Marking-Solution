import { BlobServiceClient, BlobSASPermissions } from '@azure/storage-blob'
import { DefaultAzureCredential } from '@azure/identity'
import config from '../config/index.js'

const CONTAINER_NAME = 'student-work'
const UPLOAD_SAS_TTL_MINUTES = 10

// Local: Azurite's account-key connection string (it cannot do Entra ID).
// Production: account URL + DefaultAzureCredential — the Container App's
// managed identity, so no key is stored anywhere. Mirrors db/index.js's SQL
// branch: a local-only credential path, or Entra ID when it's absent.
//
// usingManagedIdentity is retained because it changes more than just how the
// client is built — see generateUploadUrl() below, where the two credential
// types require genuinely different SAS-signing calls.
const usingManagedIdentity = !config.AZURE_STORAGE_CONNECTION_STRING

if (usingManagedIdentity && !config.AZURE_STORAGE_ACCOUNT_URL) {
    throw new Error(
        'Neither AZURE_STORAGE_CONNECTION_STRING (local emulator) nor ' +
        'AZURE_STORAGE_ACCOUNT_URL (production managed identity) is set — ' +
        'see docker-compose.yml\'s azurite service for local setup.'
    )
}

const blobServiceClient = usingManagedIdentity
    ? new BlobServiceClient(config.AZURE_STORAGE_ACCOUNT_URL, new DefaultAzureCredential())
    : BlobServiceClient.fromConnectionString(config.AZURE_STORAGE_CONNECTION_STRING)

const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME)

// These identifiers must already have been authorised by the route before
// they are used to construct or search a Blob Storage path.
function blobPathFor(teacherId, lessonId, studentId, fileName) {
    return `${teacherId}/${lessonId}/${studentId}/${fileName}`
}

export async function generateUploadUrl(teacherId, lessonId, studentId, fileName) {
    const blobPath = blobPathFor(
        teacherId,
        lessonId,
        studentId,
        fileName
    )
    const blockBlobClient = containerClient.getBlockBlobClient(blobPath)

    const sasOptions = {
        permissions: BlobSASPermissions.from({
            create: true,
            write: true,
        }),
        expiresOn: new Date(
            Date.now() + UPLOAD_SAS_TTL_MINUTES * 60 * 1000
        ),
    }

    // Two different SAS types, because the signing key differs with the
    // credential. generateSasUrl() signs with the account key and is, per the
    // SDK, "only available for BlobClient constructed with a shared key
    // credential" — it cannot work under managed identity, where no account
    // key exists in the process at all.
    //
    // The managed-identity equivalent is a user delegation SAS: ask Storage
    // for a short-lived delegation key (itself authorised by the managed
    // identity's Entra token), then sign with that. The resulting URL is the
    // same shape and is used identically by the frontend.
    //
    // NOTE: this branch cannot be exercised locally — Azurite does not
    // support Entra ID, so getUserDelegationKey() has no emulator
    // equivalent. It is unverified until it runs against a real Storage
    // account.
    if (usingManagedIdentity) {
        const now = new Date()
        const delegationKey = await blobServiceClient.getUserDelegationKey(
            now,
            sasOptions.expiresOn
        )
        return blockBlobClient.generateUserDelegationSasUrl(sasOptions, delegationKey)
    }

    return blockBlobClient.generateSasUrl(sasOptions)
}

// Finds the most recently uploaded Blob for this student. Choosing the most
// recent Blob is necessary because uploading a replacement with a different
// filename leaves the previous Blob under the same student prefix.
export async function findStudentUpload(teacherId, lessonId, studentId) {
    const prefix = `${teacherId}/${lessonId}/${studentId}/`
    let latestBlob = null

    for await (const blob of containerClient.listBlobsFlat({ prefix })) {
        const relativeName = blob.name.slice(prefix.length)

        if (!relativeName) continue

        if (!latestBlob) {
            latestBlob = blob
            continue
        }

        const candidateTime = blob.properties.lastModified?.getTime() ?? 0
        const latestTime =
            latestBlob.properties.lastModified?.getTime() ?? 0

        const isNewer =
            candidateTime > latestTime ||
            (
                candidateTime === latestTime &&
                blob.name.localeCompare(latestBlob.name) > 0
            )

        if (isNewer) latestBlob = blob
    }

    if (!latestBlob) return null

    return {
        blobName: latestBlob.name,
        fileName: latestBlob.name.slice(prefix.length),
        mimeType: latestBlob.properties.contentType || 'application/octet-stream',
    }
}
// Taking the prefix defined at the top, we loop through the entirety of that blob, and 
// return the newest blob based on the last modified date. This is necessary because if a 
// student uploads a new file with a different name, the old file will still exist in the blob 
// storage, and we want to return the most recent one.


export async function downloadStudentWork(blobName) {
    const blockBlobClient = containerClient.getBlockBlobClient(blobName)

    return blockBlobClient.downloadToBuffer()
}
// This function takes a blob name and downloads the contents of that blob to a buffer, which can then be 
// used for further processing or returned to the client.


