/**
 * Library code used by every microservice in the platform: message
 * contracts, settings, Azure client factory, structured logging, telemetry,
 * and async helpers. Built to `dist/` and installed into each service image
 * as a regular dependency (see the Dockerfiles).
 */

export * from './async.js';
export * from './azure-clients.js';
export * from './contracts.js';
export * from './logging.js';
export * from './settings.js';
export * from './shutdown.js';
export * from './telemetry.js';
