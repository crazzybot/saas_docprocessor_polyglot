// The same module instance tests get through the '@docprocessor/shared' alias.
import { setLogWriter } from './libs/ts-shared/src/index.js';

// Discard log output; tests that check logs install their own writer.
setLogWriter(() => {});
