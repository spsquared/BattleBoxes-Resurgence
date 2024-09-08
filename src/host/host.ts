import { isMainThread, parentPort } from 'worker_threads';

import { MessagePortEventEmitter } from '@/messagePortEventEmitter';

if (isMainThread || parentPort == null) throw new Error('Game host must be run in worker thread!');

const parentMessenger = new MessagePortEventEmitter(parentPort);

// create new message port for logging
process.on('uncaughtException', (err) => {

});
process.on('unhandledRejection', (err) => {

});