import pino from 'pino';
import { config } from './config';

export const logger = pino({
    level: config.log_level.toLowerCase(),
});
