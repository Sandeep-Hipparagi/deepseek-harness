import { Context, Service } from 'cordis'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface AttestationPayload {
  taskId: string
  baseCommitSha: string
  targetBranch: string
  resultingCommitSha?: string
  gitTreeSha?: string // Canonical Git tree SHA (git rev-parse HEAD^{tree})
  timestamp: string
  turnsDigest: string // SHA-256 of all turn events
  verificationDigest: string // SHA-256 of verification results
  filesModified: string[]
  modelInfo: {
    model: string
    temperature?: number
    promptTemplateHash?: string
  }
}

export interface SignedAttestation {
  format: 'in-toto-a3h-v1'
  payload: AttestationPayload
  algorithm: 'sha256-hmac' | 'ed25519'
  signature: string
  publicKey?: string
}

export interface AttestationVerificationResult {
  verified: boolean
  reason?: string
  payload?: AttestationPayload
}

export interface AttestationKeyConfig {
  algorithm?: 'ed25519' | 'sha256-hmac'
  privateKey?: string
  publicKey?: string
  secretKey?: string
}

declare module 'cordis' {
  interface Context {
    a3hAttestation: AttestationService
  }
}

export class AttestationService extends Service {
  static inject = {
    a3hStorage: { required: true },
    a3hVault: { required: false },
  }

  private internalSigningKey: string
  private ed25519PrivateKey?: string
  private ed25519PublicKey?: string
  private keyAlgorithm: 'ed25519' | 'sha256-hmac' = 'ed25519'

  constructor(ctx: Context) {
    super(ctx, 'a3hAttestation', true)

    // Initialize fallback HMAC signing key
    this.internalSigningKey =
      process.env.A3H_ATTESTATION_SECRET_KEY || crypto.randomBytes(32).toString('hex')

    // Attempt to load Ed25519 keys from environment if present
    if (process.env.A3H_ATTESTATION_PRIVATE_KEY && process.env.A3H_ATTESTATION_PUBLIC_KEY) {
      this.ed25519PrivateKey = process.env.A3H_ATTESTATION_PRIVATE_KEY
      this.ed25519PublicKey = process.env.A3H_ATTESTATION_PUBLIC_KEY
      this.keyAlgorithm = 'ed25519'
    } else {
      // Generate default in-memory Ed25519 key pair initially
      try {
        const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
          publicKeyEncoding: { type: 'spki', format: 'pem' },
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        })
        this.ed25519PrivateKey = privateKey
        this.ed25519PublicKey = publicKey
        this.keyAlgorithm = 'ed25519'
      } catch {
        this.keyAlgorithm = 'sha256-hmac'
      }
    }
  }

  configureKeys(config: AttestationKeyConfig): void {
    if (config.algorithm) {
      this.keyAlgorithm = config.algorithm
    }
    if (config.privateKey && config.publicKey) {
      this.ed25519PrivateKey = config.privateKey
      this.ed25519PublicKey = config.publicKey
      this.keyAlgorithm = 'ed25519'
    }
    if (config.secretKey) {
      this.internalSigningKey = config.secretKey
    }
  }

  getPublicKey(): string | undefined {
    return this.ed25519PublicKey
  }

  getAlgorithm(): 'ed25519' | 'sha256-hmac' {
    return this.keyAlgorithm
  }

  async ensurePersistentKeys(repoRoot?: string): Promise<{ publicKey?: string; algorithm: string }> {
    const root = repoRoot ?? process.cwd()
    const keysDir = path.resolve(root, '.agent/keys')
    const privPath = path.join(keysDir, 'attestation_ed25519_private.pem')
    const pubPath = path.join(keysDir, 'attestation_ed25519_public.pem')

    // Check VaultService first if injected
    const vault = this.ctx.a3hVault
    if (vault) {
      const vaultPriv = vault.getSecretValue('ATTESTATION_PRIVATE_KEY')
      const vaultPub = vault.getSecretValue('ATTESTATION_PUBLIC_KEY')
      if (vaultPriv && vaultPub) {
        this.ed25519PrivateKey = vaultPriv
        this.ed25519PublicKey = vaultPub
        this.keyAlgorithm = 'ed25519'
        return { publicKey: this.ed25519PublicKey, algorithm: 'ed25519' }
      }
    }

    try {
      await fs.mkdir(keysDir, { recursive: true })
      const privExists = await fs.stat(privPath).then(() => true).catch(() => false)
      const pubExists = await fs.stat(pubPath).then(() => true).catch(() => false)

      if (privExists && pubExists) {
        this.ed25519PrivateKey = await fs.readFile(privPath, 'utf8')
        this.ed25519PublicKey = await fs.readFile(pubPath, 'utf8')
        this.keyAlgorithm = 'ed25519'
        return { publicKey: this.ed25519PublicKey, algorithm: 'ed25519' }
      }

      // Generate new persistent Ed25519 key pair
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      })

      await fs.writeFile(privPath, privateKey, { mode: 0o600 })
      await fs.writeFile(pubPath, publicKey, { mode: 0o644 })

      this.ed25519PrivateKey = privateKey
      this.ed25519PublicKey = publicKey
      this.keyAlgorithm = 'ed25519'

      return { publicKey: this.ed25519PublicKey, algorithm: 'ed25519' }
    } catch {
      return { publicKey: this.ed25519PublicKey, algorithm: this.keyAlgorithm }
    }
  }

  async resolveGitTreeSha(commitOrRef: string | undefined, repoRoot: string): Promise<string | undefined> {
    const candidates = [commitOrRef, 'HEAD'].filter(Boolean) as string[]

    for (const ref of candidates) {
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', `${ref}^{tree}`], {
          cwd: repoRoot,
        })
        const treeSha = stdout.trim()
        if (treeSha && /^[0-9a-fA-F]{40}$/.test(treeSha)) {
          return treeSha
        }
      } catch {}
    }

    return undefined
  }

  calculateDigest(data: any): string {
    const serialized = typeof data === 'string' ? data : JSON.stringify(data)
    return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex')
  }

  async generateAttestation(
    taskId: string,
    metadata: {
      baseCommitSha: string
      targetBranch: string
      resultingCommitSha?: string
      turnLogs?: any[]
      verificationOutput?: string
      filesModified?: string[]
      model?: string
      repoRoot?: string
      algorithm?: 'ed25519' | 'sha256-hmac'
    },
  ): Promise<SignedAttestation> {
    const root = metadata.repoRoot ?? process.cwd()
    await this.ensurePersistentKeys(root)

    const turnsDigest = this.calculateDigest(metadata.turnLogs ?? [{ event: 'empty_turns' }])
    const verificationDigest = this.calculateDigest(metadata.verificationOutput ?? 'verified_clean')
    const gitTreeSha = await this.resolveGitTreeSha(metadata.resultingCommitSha, root)

    const payload: AttestationPayload = {
      taskId,
      baseCommitSha: metadata.baseCommitSha,
      targetBranch: metadata.targetBranch,
      resultingCommitSha: metadata.resultingCommitSha,
      gitTreeSha,
      timestamp: new Date().toISOString(),
      turnsDigest,
      verificationDigest,
      filesModified: metadata.filesModified ?? [],
      modelInfo: {
        model: metadata.model ?? 'deepseek-coder-v2',
        promptTemplateHash: this.calculateDigest('a3h-core-agent-v1'),
      },
    }

    const targetAlgo = metadata.algorithm || this.keyAlgorithm
    const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8')

    let signature: string
    let envelopeAlgo: 'ed25519' | 'sha256-hmac' = targetAlgo
    let pubKeyOut: string | undefined

    if (targetAlgo === 'ed25519' && this.ed25519PrivateKey) {
      try {
        signature = crypto.sign(null, payloadBytes, this.ed25519PrivateKey).toString('hex')
        pubKeyOut = this.ed25519PublicKey
        envelopeAlgo = 'ed25519'
      } catch {
        // Fallback to HMAC
        const hmac = crypto.createHmac('sha256', this.internalSigningKey)
        hmac.update(payloadBytes)
        signature = hmac.digest('hex')
        envelopeAlgo = 'sha256-hmac'
      }
    } else {
      const hmac = crypto.createHmac('sha256', this.internalSigningKey)
      hmac.update(payloadBytes)
      signature = hmac.digest('hex')
      envelopeAlgo = 'sha256-hmac'
    }

    const envelope: SignedAttestation = {
      format: 'in-toto-a3h-v1',
      payload,
      algorithm: envelopeAlgo,
      signature,
      publicKey: pubKeyOut,
    }

    // Persist to .agent/attestations/<taskId>.json
    const attestDir = path.resolve(root, '.agent/attestations')
    await fs.mkdir(attestDir, { recursive: true })
    const filePath = path.join(attestDir, `${taskId}.json`)
    await fs.writeFile(filePath, JSON.stringify(envelope, null, 2), 'utf8')

    return envelope
  }

  verifyAttestation(envelope: SignedAttestation, customSigningKey?: string): AttestationVerificationResult {
    if (!envelope || envelope.format !== 'in-toto-a3h-v1' || !envelope.payload || !envelope.signature) {
      return { verified: false, reason: 'Invalid attestation envelope format.' }
    }

    const payloadBytes = Buffer.from(JSON.stringify(envelope.payload), 'utf8')

    // Handle asymmetric Ed25519 verification
    if (envelope.algorithm === 'ed25519') {
      const pubKey = customSigningKey || envelope.publicKey || this.ed25519PublicKey
      if (!pubKey) {
        return {
          verified: false,
          reason: 'Public key missing for Ed25519 attestation signature verification.',
        }
      }

      try {
        const isValid = crypto.verify(
          null,
          payloadBytes,
          pubKey,
          Buffer.from(envelope.signature, 'hex'),
        )
        if (!isValid) {
          return {
            verified: false,
            reason: 'Cryptographic signature verification failed: Payload was tampered with or signed with an untrusted key.',
          }
        }
        return { verified: true, payload: envelope.payload }
      } catch (err: any) {
        return {
          verified: false,
          reason: `Cryptographic signature verification failed: ${err.message}`,
        }
      }
    }

    // Handle symmetric HMAC verification
    const key = customSigningKey ?? this.internalSigningKey
    const hmac = crypto.createHmac('sha256', key)
    hmac.update(payloadBytes)
    const expectedSig = hmac.digest('hex')

    if (expectedSig !== envelope.signature) {
      return {
        verified: false,
        reason: 'Cryptographic signature verification failed: Payload was tampered with or signed with an untrusted key.',
      }
    }

    return { verified: true, payload: envelope.payload }
  }
}
