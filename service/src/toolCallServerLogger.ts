import { format, transports, createLogger } from 'winston';

const logger = createLogger({
    level: process.env.LOG_LEVEL ?? 'info',
    defaultMeta: { service: 'tool-call-server' },
    format: format.combine(
        format.timestamp(),
        format.errors({ stack: true }),
        format.json(),
    ),
    transports: [new transports.Console()],
});

export default logger;
