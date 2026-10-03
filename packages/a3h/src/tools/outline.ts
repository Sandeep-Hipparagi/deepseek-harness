import fs from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'

export interface SymbolOutline {
  name: string
  kind: string
  startLine: number
  endLine: number
  children?: SymbolOutline[]
}

export interface FileOutlineResult {
  filePath: string
  totalLines: number
  symbols: SymbolOutline[]
}

export async function getFileOutline(worktreeRoot: string, filePath: string): Promise<FileOutlineResult> {
  const resolved = path.resolve(worktreeRoot, filePath)
  const realRoot = await fs.realpath(worktreeRoot)
  let realTarget: string
  try {
    realTarget = await fs.realpath(resolved)
  } catch {
    realTarget = resolved
  }

  const normRoot = path.normalize(realRoot).toLowerCase()
  const normTarget = path.normalize(realTarget).toLowerCase()

  if (!normTarget.startsWith(normRoot)) {
    throw new Error('Access denied: Path outside assigned worktree.')
  }

  const content = await fs.readFile(resolved, 'utf-8')
  const lines = content.split('\n')
  const ext = path.extname(filePath).toLowerCase()

  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
    )
    const symbols = extractTsSymbols(sourceFile)
    return {
      filePath,
      totalLines: lines.length,
      symbols,
    }
  }

  // Fallback for Python, Go, and generic source files
  const symbols = extractGenericSymbols(content, lines)
  return {
    filePath,
    totalLines: lines.length,
    symbols,
  }
}

function extractTsSymbols(sourceFile: ts.SourceFile): SymbolOutline[] {
  const symbols: SymbolOutline[] = []

  function visit(node: ts.Node): SymbolOutline | null {
    let name = ''
    let kind = ''

    if (ts.isClassDeclaration(node)) {
      name = node.name?.getText(sourceFile) || '<anonymous class>'
      kind = 'class'
    } else if (ts.isInterfaceDeclaration(node)) {
      name = node.name.getText(sourceFile)
      kind = 'interface'
    } else if (ts.isTypeAliasDeclaration(node)) {
      name = node.name.getText(sourceFile)
      kind = 'type'
    } else if (ts.isFunctionDeclaration(node)) {
      name = node.name?.getText(sourceFile) || '<anonymous function>'
      kind = 'function'
    } else if (ts.isMethodDeclaration(node)) {
      name = node.name.getText(sourceFile)
      kind = 'method'
    } else if (ts.isConstructorDeclaration(node)) {
      name = 'constructor'
      kind = 'constructor'
    } else if (ts.isPropertyDeclaration(node)) {
      name = node.name.getText(sourceFile)
      kind = 'property'
    }

    if (name && kind) {
      const { line: startLine } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      const { line: endLine } = sourceFile.getLineAndCharacterOfPosition(node.getEnd())
      const outline: SymbolOutline = {
        name,
        kind,
        startLine: startLine + 1,
        endLine: endLine + 1,
        children: [],
      }

      ts.forEachChild(node, (child) => {
        const childOutline = visit(child)
        if (childOutline) {
          outline.children!.push(childOutline)
        }
      })

      return outline
    }

    ts.forEachChild(node, (child) => {
      const item = visit(child)
      if (item) symbols.push(item)
    })

    return null
  }

  ts.forEachChild(sourceFile, (node) => {
    const item = visit(node)
    if (item) symbols.push(item)
  })

  return symbols
}

function extractGenericSymbols(content: string, lines: string[]): SymbolOutline[] {
  const symbols: SymbolOutline[] = []
  const pyClassRegex = /^class\s+([a-zA-Z0-9_]+)/
  const pyFuncRegex = /^def\s+([a-zA-Z0-9_]+)/

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const classMatch = line.match(pyClassRegex)
    if (classMatch) {
      symbols.push({
        name: classMatch[1],
        kind: 'class',
        startLine: i + 1,
        endLine: i + 1,
      })
      continue
    }
    const funcMatch = line.match(pyFuncRegex)
    if (funcMatch) {
      symbols.push({
        name: funcMatch[1],
        kind: 'function',
        startLine: i + 1,
        endLine: i + 1,
      })
    }
  }

  return symbols
}
