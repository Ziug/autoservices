// Generates an unguessable Super Admin base path.
// Usage: node scripts/generate-admin-path.mjs
// Prints a VITE_ADMIN_PATH line for your local .env — do NOT commit the secret.
// The path is obscurity only; real authorization is enforced server-side
// by the admin-api Edge Function. Rotate by generating a new value + rebuild.
import {randomBytes} from 'node:crypto';

const secret = randomBytes(16).toString('hex');
console.log(`VITE_ADMIN_PATH=/control/${secret}`);
