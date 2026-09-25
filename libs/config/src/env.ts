import { z } from 'zod';

/**
 * The environment every service reads, and the only one this library claims to
 * know about. Service-specific variables belong to that service.
 *
 * ⚠ IT PARSES ONCE, AT STARTUP, AND THROWS. A configuration fault is not a
 *   runtime condition to degrade around — it is a deployment that should not
 *   have started. Reading `process.env` again later, anywhere, defeats this.
 */
export const EnvSchema: z.ZodObject<{
  NODE_ENV: z.ZodEnum<{ development: 'development'; test: 'test'; production: 'production' }>;
  PORT: z.ZodCoercedNumber<unknown>;
}> = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),

  // Coerced because an environment variable is always a string, and every
  // service is handed its port by the platform rather than choosing one.
  PORT: z.coerce.number().int().min(1).max(65535),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Read and validate the environment.
 *
 * @param source - defaults to `process.env`; injected in tests
 * @throws {z.ZodError} when a variable is missing or malformed
 */
export function readEnv(source: Record<string, string | undefined> = process.env): Env {
  return EnvSchema.parse(source);
}

/**
 * ⚠ An allow-list of the two non-production environments, not `=== 'production'`:
 *   a `staging` added to `EnvSchema` is then production-like until someone says
 *   otherwise, so widening the schema cannot quietly open a guarded route.
 */
export function isProductionEnvironment(
  source: Record<string, string | undefined> = process.env,
): boolean {
  const { NODE_ENV } = readEnv(source);
  return NODE_ENV !== 'development' && NODE_ENV !== 'test';
}
