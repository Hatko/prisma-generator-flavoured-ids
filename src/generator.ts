import {
  DMMF,
  generatorHandler,
  GeneratorOptions,
} from '@prisma/generator-helper'
import { logger } from '@prisma/internals'
import fs from 'node:fs'
import { GENERATOR_NAME } from './constants'

const { version } = require('../package.json')

/**
 * Edit operation for efficient string manipulation
 */
interface Edit {
  start: number
  end: number
  replacement: string
}

/**
 * Find the end of a type block (matching closing brace)
 */
function findBlockEnd(content: string, openBraceIndex: number): number {
  let braceCount = 1
  for (let i = openBraceIndex + 1; i < content.length; i++) {
    if (content[i] === '{') braceCount++
    else if (content[i] === '}') {
      braceCount--
      if (braceCount === 0) return i
    }
  }
  return content.length
}

/**
 * Apply all edits to content efficiently using a single-pass chunk-based approach
 * Edits are sorted by position and applied by building result from chunks
 */
function applyEdits(content: string, edits: Edit[]): string {
  // Sort by start position ascending for single-pass processing
  edits.sort((a, b) => a.start - b.start)

  // Remove overlapping edits (keep first one at each position)
  const finalEdits: Edit[] = []
  let lastEnd = 0
  for (const edit of edits) {
    if (edit.start >= lastEnd) {
      finalEdits.push(edit)
      lastEnd = edit.end
    }
  }

  // Build result in a single pass by collecting chunks
  const chunks: string[] = []
  let pos = 0
  for (const edit of finalEdits) {
    if (edit.start > pos) {
      chunks.push(content.slice(pos, edit.start))
    }
    chunks.push(edit.replacement)
    pos = edit.end
  }
  // Add remaining content
  if (pos < content.length) {
    chunks.push(content.slice(pos))
  }

  return chunks.join('')
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

generatorHandler({
  onManifest() {
    logger.info(`${GENERATOR_NAME}:Registered`)

    return {
      version,
      defaultOutput: '../generated',
      prettyName: GENERATOR_NAME,
    }
  },
  onGenerate: async (options: GeneratorOptions) => {
    const output = options.generator.output?.value

    if (!output) {
      return
    }

    // Check for strictFlavours option (default: false for backward compatibility)
    const strictFlavours = options.generator.config.strictFlavours === 'true'

    const idTypeHeader = strictFlavours
      ? `
    export interface Flavoring<FlavorT> {
      _type: FlavorT
    }
    export type Flavor<T, FlavorT> = T & Flavoring<FlavorT>
    `
      : `
    export interface Flavoring<FlavorT> {
      _type?: FlavorT
    }
    export type Flavor<T, FlavorT> = T & Flavoring<FlavorT>
    `

    const fileContent = fs.readFileSync(output, 'utf8')
    const fullContent = idTypeHeader + fileContent

    // Pre-process: build model data
    const modelIdTypes = new Map<string, string>()
    const modelsWithId: Array<{
      modelName: string
      idField: DMMF.Field
      model: DMMF.Model
    }> = []

    for (const model of options.dmmf.datamodel.models) {
      const idField = model.fields.find(
        ({ name, isId }) => name === 'id' && isId,
      )
      if (idField) {
        modelIdTypes.set(model.name, `${model.name}Id`)
        modelsWithId.push({ modelName: model.name, idField, model })
      }
    }

    // Build replacement map for combined regex
    const replacements = new Map<string, string>()
    const insertions = new Map<string, string>()

    for (const { modelName, model } of modelsWithId) {
      const idTypeName = `${modelName}Id`
      const typeDefinition = `\nexport type ${idTypeName} = Flavor<string, '__${modelName}Id'>\n`

      // Type definition insertion marker
      insertions.set(`export type ${modelName} = `, typeDefinition)

      // stronglyTypedName patterns (e.g., userId: string -> userId: UserId)
      const stronglyTypedName =
        idTypeName.charAt(0).toLowerCase() + idTypeName.slice(1)
      replacements.set(
        `${stronglyTypedName}: string`,
        `${stronglyTypedName}: ${idTypeName}`,
      )
      replacements.set(
        `${stronglyTypedName}?: string`,
        `${stronglyTypedName}?: ${idTypeName}`,
      )

      // Foreign key patterns
      const relationFields = model.fields.filter(
        (field) => field.kind === 'object' && field.relationFromFields,
      )
      for (const relationField of relationFields) {
        if (!relationField.relationFromFields) continue

        const relatedModelName = relationField.type
        const relatedIdType = modelIdTypes.get(relatedModelName)
        if (!relatedIdType) continue

        for (const fk of relationField.relationFromFields) {
          replacements.set(
            `${fk}: string | null`,
            `${fk}: ${relatedIdType} | null`,
          )
          replacements.set(
            `${fk}?: string | null`,
            `${fk}?: ${relatedIdType} | null`,
          )
          replacements.set(`${fk}: string`, `${fk}: ${relatedIdType}`)
          replacements.set(`${fk}?: string`, `${fk}?: ${relatedIdType}`)
        }
      }
    }

    // Sort patterns by length (longest first) for correct matching
    const allPatterns = [...replacements.keys(), ...insertions.keys()]
    allPatterns.sort((a, b) => b.length - a.length)

    // Build combined regex
    const combinedPattern = allPatterns.map(escapeRegex).join('|')
    const combinedRegex = new RegExp(combinedPattern, 'g')

    // First pass: handle global replacements and insertions
    let result = fullContent.replace(combinedRegex, (match) => {
      const insertion = insertions.get(match)
      if (insertion) return insertion + match

      const replacement = replacements.get(match)
      if (replacement) return replacement

      return match
    })

    // Second pass: handle block-scoped replacements and replaceType patterns
    const edits: Edit[] = []
    // Skip non-ID types like Date, DateTime, Int, Float, etc.
    const nonIdTypes = /^(Date|DateTime|Int|Float|Decimal|BigInt|Boolean|Bytes)\s*$/

    for (const { modelName, idField, model } of modelsWithId) {
      const idTypeName = `${modelName}Id`
      const stronglyTypedName =
        idTypeName.charAt(0).toLowerCase() + idTypeName.slice(1)

      // $Payload scalars section
      const payloadMarker = `type $${modelName}Payload<`
      const payloadIdx = result.indexOf(payloadMarker)
      if (payloadIdx !== -1) {
        const scalarsIdx = result.indexOf('scalars:', payloadIdx)
        if (scalarsIdx !== -1) {
          const scalarsBlockStart = result.indexOf('{', scalarsIdx) + 1
          const scalarsBlockEnd = findBlockEnd(result, scalarsBlockStart - 1)

          const idSearch = `  ${idField.name}: string`
          const idIdx = result.indexOf(idSearch, scalarsBlockStart)
          if (idIdx !== -1 && idIdx < scalarsBlockEnd) {
            edits.push({
              start: idIdx,
              end: idIdx + idSearch.length,
              replacement: `  ${idField.name}: ${idTypeName}`,
            })
          }
        }
      }

      // Input types - block-scoped id field replacement
      const inputTypes = [
        `${modelName}CreateInput`,
        `${modelName}UncheckedCreateInput`,
        `${modelName}UpdateInput`,
        `${modelName}UncheckedUpdateInput`,
        `${modelName}UpdateManyMutationInput`,
        `${modelName}UncheckedUpdateManyInput`,
      ]
      for (const inputType of inputTypes) {
        const inputIdx = result.indexOf(`export type ${inputType} = {`)
        if (inputIdx === -1) continue

        const blockStart = result.indexOf('{', inputIdx) + 1
        const blockEnd = findBlockEnd(result, blockStart - 1)

        let searchIdx = blockStart
        const searchOptional = `${idField.name}?: string`
        while (
          (searchIdx = result.indexOf(searchOptional, searchIdx)) !== -1 &&
          searchIdx < blockEnd
        ) {
          edits.push({
            start: searchIdx,
            end: searchIdx + searchOptional.length,
            replacement: `${idField.name}?: ${idTypeName}`,
          })
          searchIdx += searchOptional.length
        }

        searchIdx = blockStart
        const searchRequired = `${idField.name}: string`
        while (
          (searchIdx = result.indexOf(searchRequired, searchIdx)) !== -1 &&
          searchIdx < blockEnd
        ) {
          edits.push({
            start: searchIdx,
            end: searchIdx + searchRequired.length,
            replacement: `${idField.name}: ${idTypeName}`,
          })
          searchIdx += searchRequired.length
        }
      }

      // WithoutInput types
      const withoutRegex = new RegExp(
        `export type ${modelName}(?:Unchecked)?(?:Create|Update)Without\\w+Input = \\{`,
        'g',
      )
      let match
      while ((match = withoutRegex.exec(result)) !== null) {
        const blockStart = result.indexOf('{', match.index) + 1
        const blockEnd = findBlockEnd(result, blockStart - 1)

        let searchIdx = blockStart
        const searchOptional = `${idField.name}?: string`
        while (
          (searchIdx = result.indexOf(searchOptional, searchIdx)) !== -1 &&
          searchIdx < blockEnd
        ) {
          edits.push({
            start: searchIdx,
            end: searchIdx + searchOptional.length,
            replacement: `${idField.name}?: ${idTypeName}`,
          })
          searchIdx += searchOptional.length
        }

        searchIdx = blockStart
        const searchRequired = `${idField.name}: string`
        while (
          (searchIdx = result.indexOf(searchRequired, searchIdx)) !== -1 &&
          searchIdx < blockEnd
        ) {
          edits.push({
            start: searchIdx,
            end: searchIdx + searchRequired.length,
            replacement: `${idField.name}: ${idTypeName}`,
          })
          searchIdx += searchRequired.length
        }
      }

      // WhereInput
      const whereInputIdx = result.indexOf(
        `export type ${modelName}WhereInput = {`,
      )
      if (whereInputIdx !== -1) {
        const blockStart = result.indexOf('{', whereInputIdx) + 1
        const blockEnd = findBlockEnd(result, blockStart - 1)

        const search1 = `${idField.name}: StringFilter<"${modelName}"> | string`
        const idx1 = result.indexOf(search1, blockStart)
        if (idx1 !== -1 && idx1 < blockEnd) {
          edits.push({
            start: idx1,
            end: idx1 + search1.length,
            replacement: `${idField.name}: StringFilter<"${modelName}"> | ${idTypeName}`,
          })
        }

        const search2 = `${idField.name}?: StringFilter<"${modelName}"> | string`
        const idx2 = result.indexOf(search2, blockStart)
        if (idx2 !== -1 && idx2 < blockEnd) {
          edits.push({
            start: idx2,
            end: idx2 + search2.length,
            replacement: `${idField.name}?: StringFilter<"${modelName}"> | ${idTypeName}`,
          })
        }
      }

      // WhereUniqueInput
      const whereUniqueIdx = result.indexOf(
        `export type ${modelName}WhereUniqueInput = Prisma.AtLeast<{`,
      )
      if (whereUniqueIdx !== -1) {
        const blockStart = result.indexOf('{', whereUniqueIdx) + 1
        const blockEnd = findBlockEnd(result, blockStart - 1)

        // Handle non-optional id: string
        const search1 = `  ${idField.name}: string`
        const idx1 = result.indexOf(search1, blockStart)
        if (idx1 !== -1 && idx1 < blockEnd) {
          edits.push({
            start: idx1,
            end: idx1 + search1.length,
            replacement: `  ${idField.name}: ${idTypeName}`,
          })
        }

        // Handle optional id?: string
        const search2 = `  ${idField.name}?: string`
        const idx2 = result.indexOf(search2, blockStart)
        if (idx2 !== -1 && idx2 < blockEnd) {
          edits.push({
            start: idx2,
            end: idx2 + search2.length,
            replacement: `  ${idField.name}?: ${idTypeName}`,
          })
        }
      }

      // replaceType patterns (handle union types like key?: SomeType | string)
      // Use word boundary to avoid matching fields that just end with the same suffix
      const replaceTypeRegex = new RegExp(
        `\\b${escapeRegex(stronglyTypedName)}\\s*\\?:\\s*([^|]+)\\s*\\|\\s*string`,
        'g',
      )
      while ((match = replaceTypeRegex.exec(result)) !== null) {
        const capturedType = match[1].trim()
        if (nonIdTypes.test(capturedType)) continue // Skip non-ID fields
        edits.push({
          start: match.index,
          end: match.index + match[0].length,
          replacement: `${stronglyTypedName}?: ${match[1]} | ${idTypeName}`,
        })
      }

      // Foreign key replaceType patterns
      const relationFields = model.fields.filter(
        (field) => field.kind === 'object' && field.relationFromFields,
      )
      for (const relationField of relationFields) {
        if (!relationField.relationFromFields) continue

        const relatedModelName = relationField.type
        const relatedIdType = modelIdTypes.get(relatedModelName)
        if (!relatedIdType) continue

        for (const fk of relationField.relationFromFields) {
          // Use word boundary to avoid matching fields that just end with the same suffix
          const fkRegex = new RegExp(
            `\\b${escapeRegex(fk)}\\s*\\?:\\s*([^|]+)\\s*\\|\\s*string`,
            'g',
          )
          while ((match = fkRegex.exec(result)) !== null) {
            const capturedType = match[1].trim()
            if (nonIdTypes.test(capturedType)) continue // Skip non-ID fields
            edits.push({
              start: match.index,
              end: match.index + match[0].length,
              replacement: `${fk}?: ${match[1]} | ${relatedIdType}`,
            })
          }
        }
      }
    }

    if (edits.length > 0) {
      result = applyEdits(result, edits)
    }

    fs.writeFileSync(output, result)
  },
})
