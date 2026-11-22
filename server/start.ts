// Production entry point. Setting NODE_ENV before the dynamic import keeps the
// session cookie secure and avoids relying on shell-specific `VAR=value` syntax.
process.env.NODE_ENV ??= 'production'
await import('./index.ts')
