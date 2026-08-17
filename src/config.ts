import 'dotenv/config';

/** 런타임 설정. 시크릿은 전부 env 주입(번들 0). */
export const config = {
  host: process.env.COXPIT_HOST ?? '127.0.0.1',
  port: Number(process.env.COXPIT_PORT ?? 8210),
  dbPath: process.env.COXPIT_DB ?? './coxpit.db',
  auth: {
    disabled: process.env.COXPIT_AUTH_DISABLED === '1',
    user: process.env.COXPIT_AUTH_USER ?? 'admin',
    pass: process.env.COXPIT_AUTH_PASS ?? '',
  },
} as const;
