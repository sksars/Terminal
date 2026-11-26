import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';

const configResponse = await fetch(new URL('../firebase-applet-config.json', import.meta.url));
if (!configResponse.ok) {
  throw new Error(`Failed to load firebase-applet-config.json (${configResponse.status})`);
}
const firebaseConfig = await configResponse.json();

const RTDB_URL = 'https://gen-lang-client-0127584836-default-rtdb.firebaseio.com';
const app = initializeApp({ ...firebaseConfig, databaseURL: RTDB_URL }, 'droidlab-rtdb-primary');
const rtdb = getDatabase(app, RTDB_URL);

export function getRtdb() {
  return rtdb;
}

export function getActiveRtdbUrl() {
  return RTDB_URL;
}

export const OperationType = Object.freeze({
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
});

export function handleRtdbError(error, operationType, path) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    databaseURL: RTDB_URL,
    operationType,
    path,
  };
  console.error('Realtime Database Error:', JSON.stringify(errInfo));
  return errInfo;
}

export { firebaseConfig };
