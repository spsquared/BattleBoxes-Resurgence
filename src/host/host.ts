import { isMainThread } from 'worker_threads';
if (isMainThread) throw new Error('Game host must be run in worker thread!');