// Centralized configuration with env-var fallbacks.
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PORT_WSS, DEFAULT_PORT_HTTP } from '../../shared/protocol.js';

const dataDir = process.env.CLIPSYNC_DATA_DIR
  || path.join(os.homedir(), '.config', 'clipsync', 'hub');

export const CONFIG = {
  PORT_WSS:    parseInt(process.env.CLIPSYNC_PORT_WSS  || DEFAULT_PORT_WSS,  10),
  PORT_HTTP:   parseInt(process.env.CLIPSYNC_PORT_HTTP || DEFAULT_PORT_HTTP, 10),
  HOST:        process.env.CLIPSYNC_HOST || '0.0.0.0',
  DATA_DIR:    dataDir,
  DB_PATH:     path.join(dataDir, 'clipsync.db'),
  TLS_DIR:     path.join(dataDir, 'tls'),
  HISTORY_TTL_MS: parseInt(process.env.CLIPSYNC_HISTORY_TTL_MS || (24 * 60 * 60 * 1000), 10),
  HISTORY_MAX:    parseInt(process.env.CLIPSYNC_HISTORY_MAX    || 50, 10),
  HUB_NAME:    process.env.CLIPSYNC_HUB_NAME || os.hostname(),
  PIN_TTL_MS:  5 * 60 * 1000,
  PING_INTERVAL_MS: 25_000,
  TOKEN_ROTATION_MS: 30 * 24 * 60 * 60 * 1000,
};
