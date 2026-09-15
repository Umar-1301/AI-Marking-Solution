import { ServiceBusClient } from '@azure/service-bus'
import { DefaultAzureCredential } from '@azure/identity'
import config from '../config/index.js'

// The only place a ServiceBusClient gets constructed — same reasoning as
// db/index.js having the one dbConfig branch: one call site, one place to
// see which path is active, no risk of local and production connecting
// differently depending on which file happened to import what.
//
// Local: the emulator's connection string (it cannot do Entra ID).
// Production: namespace + DefaultAzureCredential — the Container App's
// managed identity, resolved at runtime, so no secret is stored anywhere.
// This mirrors db/index.js's SQL branch exactly: a local-only credential
// path, or Entra ID when that credential is absent.
//
// Local wins when both are set: a developer's .env should never be
// silently overridden by a stray production value.
const serviceBusClient = config.AZURE_SERVICEBUS_CONNECTION_STRING
    ? new ServiceBusClient(config.AZURE_SERVICEBUS_CONNECTION_STRING)
    : (() => {
        if (!config.AZURE_SERVICEBUS_NAMESPACE) {
            throw new Error(
                'Neither AZURE_SERVICEBUS_CONNECTION_STRING (local emulator) nor ' +
                'AZURE_SERVICEBUS_NAMESPACE (production managed identity) is set — ' +
                'see docker-compose.yml\'s servicebus-emulator service for local setup.'
            )
        }
        return new ServiceBusClient(
            config.AZURE_SERVICEBUS_NAMESPACE,
            new DefaultAzureCredential()
        )
    })()

const STUDENT_MARKING_QUEUE = 'student-marking'
const studentMarkingSender = serviceBusClient.createSender(STUDENT_MARKING_QUEUE)

// Sends a verified marking request to the worker. The route is responsible
// for authorising every identifier and confirming the Blob exists before it
// reaches here; this service is responsible only for publishing that request.
export async function sendStudentMarkingRequest(request) {
    await studentMarkingSender.sendMessages({
        body: request,
        contentType: 'application/json',
        subject: 'student-marking-request',
    })
}

export default serviceBusClient
