// Service Bus connection for this worker service — retrieval only.
//
// Sending to the queue is the backend's concern and lives there
// (backend/src/services/queueService.js). This file exists solely so
// markingWorker.js has a connection to receive from; nothing here should
// grow a sender.
//
// Local uses the emulator's connection string (the emulator cannot do
// Entra ID at all). Production uses the namespace hostname plus the
// container's own managed identity, so no secret is stored.
import { ServiceBusClient } from '@azure/service-bus'
import { DefaultAzureCredential } from '@azure/identity'

const connectionString = process.env.AZURE_SERVICEBUS_CONNECTION_STRING || null
const namespace = process.env.AZURE_SERVICEBUS_NAMESPACE || null

const serviceBusClient = connectionString
    ? new ServiceBusClient(connectionString)
    : (() => {
        if (!namespace) {
            throw new Error(
                'Neither AZURE_SERVICEBUS_CONNECTION_STRING (local emulator) nor ' +
                'AZURE_SERVICEBUS_NAMESPACE (production managed identity) is set — ' +
                'see workers/env/.env.example.'
            )
        }
        return new ServiceBusClient(namespace, new DefaultAzureCredential())
    })()

export default serviceBusClient
