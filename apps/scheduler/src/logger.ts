type Fields = Record<string, unknown>;

function emit(level: string, message: string, fields?: Fields): void {
  const record: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    service: 'scheduler',
    message,
  };
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) record[key] = value;
    }
  }
  process.stdout.write(JSON.stringify(record) + '\n');
}

export const logger = {
  info(message: string, fields?: Fields): void {
    emit('info', message, fields);
  },
  warn(message: string, fields?: Fields): void {
    emit('warn', message, fields);
  },
  error(message: string, fields?: Fields): void {
    emit('error', message, fields);
  },
};
