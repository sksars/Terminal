import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';

const firebaseConfig = {
  apiKey: 'AIzaSyBZ4Q186AqrN2vVtm38_sJZzNiE_djtIPE',
  authDomain: 'heck-sars.firebaseapp.com',
  databaseURL: 'https://heck-sars-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'heck-sars',
  storageBucket: 'heck-sars.firebasestorage.app',
  messagingSenderId: '1009881645511',
  appId: '1:1009881645511:android:c5201ab3d864b1190159e2',
};

const RTDB_URL = firebaseConfig.databaseURL;
const app = initializeApp(firebaseConfig, 'droidlab-rtdb-primary');
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
