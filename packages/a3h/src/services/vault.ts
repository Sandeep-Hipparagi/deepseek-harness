import { Context, Service } from 'cordis'
import crypto from 'node:crypto'

export interface SecretMetadata {
  description?: string
  allowedScopes?: string[]
  owner?: string
}

export interface EphemeralToken {
  id: string
  tokenString: string
  secretKey: string
  scope: string[]
  issuedAt: number // ms
  expiresAt: number // ms
  isExpired: boolean
}

export interface TokenValidationResult {
  valid: boolean
  reason?: string
  token?: EphemeralToken
}

export interface EgressCheckResult {
  allowed: boolean
  host: string
  reason?: string
}

declare module 'cordis' {
  interface Context {
    a3hVault: VaultService
  }
  interface Events {
    'a3h/vault-token-issued'(evt: { tokenId: string; secretKey: string; expiresAt: number }): void
    'a3h/egress-blocked'(evt: { host: string; url: string; reason: string }): void
  }
}

export class VaultService extends Service {
  private secrets = new Map<string, { value: string; metadata?: SecretMetadata }>()
  private activeTokens = new Map<string, EphemeralToken>()
  private egressAllowlist = new Set<string>([
    'registry.npmjs.org',
    'registry.yarnpkg.com',
    'github.com',
    'api.github.com',
    'localhost',
    '127.0.0.1',
  ])

  constructor(ctx: Context) {
    super(ctx, 'a3hVault', true)
  }

  registerSecret(key: string, value: string, metadata?: SecretMetadata): void {
    this.secrets.set(key, { value, metadata })
  }

  getSecretValue(key: string): string | undefined {
    return this.secrets.get(key)?.value
  }

  issueJITToken(secretKey: string, scope: string[] = ['read'], ttlSeconds: number = 300): EphemeralToken {
    const secret = this.secrets.get(secretKey)
    if (!secret) {
      throw new Error(`Vault error: Secret key '${secretKey}' is not registered in vault.`)
    }

    const tokenId = `tok_${crypto.randomBytes(8).toString('hex')}`
    const tokenString = `a3h_jit_${crypto.randomBytes(24).toString('hex')}`
    const now = Date.now()
    const expiresAt = now + ttlSeconds * 1000

    const token: EphemeralToken = {
      id: tokenId,
      tokenString,
      secretKey,
      scope,
      issuedAt: now,
      expiresAt,
      get isExpired() {
        return Date.now() > this.expiresAt
      },
    }

    this.activeTokens.set(tokenString, token)
    this.ctx.emit('a3h/vault-token-issued', { tokenId, secretKey, expiresAt })
    return token
  }

  validateToken(tokenString: string, requiredScope?: string): TokenValidationResult {
    const token = this.activeTokens.get(tokenString)
    if (!token) {
      return { valid: false, reason: 'Token not found or invalid format.' }
    }

    if (Date.now() > token.expiresAt) {
      this.activeTokens.delete(tokenString)
      return { valid: false, reason: 'Token has expired (TTL elapsed).' }
    }

    if (requiredScope && !token.scope.includes(requiredScope) && !token.scope.includes('*')) {
      return { valid: false, reason: `Token does not possess required scope: '${requiredScope}'.` }
    }

    return { valid: true, token }
  }

  sanitizeEnvironment(env: Record<string, string | undefined>): Record<string, string> {
    const sanitized: Record<string, string> = {}
    const secretValues = Array.from(this.secrets.values()).map(s => s.value)

    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) continue

      let safeValue = v
      for (const secretVal of secretValues) {
        if (secretVal && safeValue.includes(secretVal)) {
          safeValue = safeValue.replaceAll(secretVal, '***MASKED_BY_A3H_VAULT***')
        }
      }

      // Check if key itself is a sensitive credential
      const upper = k.toUpperCase()
      if (
        upper.includes('SECRET') ||
        upper.includes('PASSWORD') ||
        upper.includes('TOKEN') ||
        upper.includes('KEY') ||
        upper.includes('CREDENTIAL')
      ) {
        safeValue = '***MASKED_BY_A3H_VAULT***'
      }

      sanitized[k] = safeValue
    }

    return sanitized
  }

  addEgressAllowlist(domain: string): void {
    this.egressAllowlist.add(domain.toLowerCase())
  }

  checkEgressAllowed(targetUrlOrHost: string): EgressCheckResult {
    let host = targetUrlOrHost.trim().toLowerCase()
    try {
      if (host.startsWith('http://') || host.startsWith('https://')) {
        const url = new URL(host)
        host = url.hostname
      }
    } catch {}

    // Check allowlist
    const isAllowed = this.egressAllowlist.has(host) || Array.from(this.egressAllowlist).some(allowed => host.endsWith(`.${allowed}`))

    if (!isAllowed) {
      this.ctx.emit('a3h/egress-blocked', {
        host,
        url: targetUrlOrHost,
        reason: 'Outbound network egress to unapproved domain is blocked by zero-trust security policy.',
      })
      return {
        allowed: false,
        host,
        reason: `Egress blocked: Host '${host}' is not on the corporate network allowlist.`,
      }
    }

    return { allowed: true, host }
  }
}
