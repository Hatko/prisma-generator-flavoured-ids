import {
  DMMF,
  generatorHandler,
  GeneratorOptions,
} from '@prisma/generator-helper'
import { logger } from '@prisma/internals'
import { GENERATOR_NAME } from './constants'
import fs from 'node:fs'

const { version } = require('../package.json')

const replaceAt = (
  value: string,
  search: string,
  replace: string,
  from: number,
) => {
  if (value.length > from) {
    return value.slice(0, from) + value.slice(from).replace(search, replace)
  }
  return value
}

const replaceType = (inputString: string, key: string, newType: string) => {
  const regex = new RegExp(`${key}\\s*\\?:\\s*([^|]+)\\s*\\|\\s*string`, 'g')
  return inputString.replace(regex, `${key}?: $1 | ${newType}`)
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
    const strictFlavours =
      options.generator.config.strictFlavours === 'true'

    const idType = strictFlavours
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

    let resultFileContent = idType + fs.readFileSync(output, 'utf8')

    // Build a map of model names to their ID types
    const modelIdTypes = new Map<string, string>()
    options.dmmf.datamodel.models.forEach((model) => {
      const idField = model.fields.find(
        ({ name, isId }) => name === 'id' && isId,
      )
      if (idField) {
        modelIdTypes.set(model.name, `${model.name}Id`)
      }
    })

    options.dmmf.datamodel.models
      .map((model) => {
        const idField = model.fields.find(
          ({ name, isId }) => name === 'id' && isId,
        )

        return { idField, modelName: model.name, model }
      })
      .filter(
        (
          fieldInfo,
        ): fieldInfo is {
          modelName: string
          idField: DMMF.Field
          model: DMMF.Model
        } => !!fieldInfo.idField,
      )
      .forEach(async ({ idField, modelName, model }) => {
        const idTypeName = `${modelName}Id`
        const idType = `\nexport type ${idTypeName} = Flavor<string, '__${modelName}Id'>`

        //
        // Add id type above type definition
        const originalExport = `export type ${modelName} = `
        resultFileContent = resultFileContent.replace(
          originalExport,
          `${idType}\n${originalExport}`,
        )
        //

        //
        // Update Model ID type
        const res = resultFileContent.search(`type \\$${modelName}Payload<`)
        resultFileContent = replaceAt(
          resultFileContent,
          `  ${idField.name}: string`,
          `  ${idField.name}: ${idTypeName}`,
          res,
        )
        //

        //
        // Replace by name (e.g. "userId") in code
        const stronglyTypedName = `${idTypeName.charAt(0).toLowerCase() + idTypeName.slice(1)
          }`
        resultFileContent = resultFileContent.replace(
          new RegExp(`${stronglyTypedName}: string`, 'g'),
          `${stronglyTypedName}: ${idTypeName}`,
        )

        resultFileContent = resultFileContent.replace(
          new RegExp(`${stronglyTypedName}\\?: string`, 'g'),
          `${stronglyTypedName}?: ${idTypeName}`,
        )

        resultFileContent = replaceType(
          resultFileContent,
          stronglyTypedName,
          idTypeName,
        )
        //


        //
        // Update CreateInput types for model's own id field
        const createInputPatterns = [
          `${modelName}CreateInput`,
          `${modelName}UncheckedCreateInput`,
        ]
        createInputPatterns.forEach((inputType) => {
          const inputStart = resultFileContent.search(
            new RegExp(`export type ${inputType} = \\{`),
          )
          if (inputStart === -1) return

          // Find the end of this type definition (look for closing brace at same indentation level)
          const typeContentStart = resultFileContent.indexOf('{', inputStart) + 1
          let braceCount = 1
          let typeEnd = typeContentStart
          for (let i = typeContentStart; i < resultFileContent.length; i++) {
            if (resultFileContent[i] === '{') braceCount++
            if (resultFileContent[i] === '}') {
              braceCount--
              if (braceCount === 0) {
                typeEnd = i
                break
              }
            }
          }

          // Extract and modify only this type's content
          const typeContent = resultFileContent.slice(
            typeContentStart,
            typeEnd,
          )
          const updatedTypeContent = typeContent
            .replace(
              new RegExp(`(\\s+)${idField.name}\\?:\\s*string\\b`, 'g'),
              `$1${idField.name}?: ${idTypeName}`,
            )
            .replace(
              new RegExp(`(\\s+)${idField.name}:\\s*string\\b`, 'g'),
              `$1${idField.name}: ${idTypeName}`,
            )

          // Replace in the full content
          resultFileContent =
            resultFileContent.slice(0, typeContentStart) +
            updatedTypeContent +
            resultFileContent.slice(typeEnd)
        })
        //

        //
        // Update CreateWithout* and UncheckedCreateWithout* types
        // Use regex to find all variants (e.g., CreateWithoutFundInput, CreateWithoutUserInput)
        const createWithoutRegex = new RegExp(
          `export type ${modelName}(?:Unchecked)?CreateWithout\\w+Input = \\{`,
          'g',
        )
        let match
        while ((match = createWithoutRegex.exec(resultFileContent)) !== null) {
          const typeContentStart =
            resultFileContent.indexOf('{', match.index) + 1
          let braceCount = 1
          let typeEnd = typeContentStart
          for (let i = typeContentStart; i < resultFileContent.length; i++) {
            if (resultFileContent[i] === '{') braceCount++
            if (resultFileContent[i] === '}') {
              braceCount--
              if (braceCount === 0) {
                typeEnd = i
                break
              }
            }
          }

          const typeContent = resultFileContent.slice(
            typeContentStart,
            typeEnd,
          )
          const updatedTypeContent = typeContent
            .replace(
              new RegExp(`(\\s+)${idField.name}\\?:\\s*string\\b`, 'g'),
              `$1${idField.name}?: ${idTypeName}`,
            )
            .replace(
              new RegExp(`(\\s+)${idField.name}:\\s*string\\b`, 'g'),
              `$1${idField.name}: ${idTypeName}`,
            )

          resultFileContent =
            resultFileContent.slice(0, typeContentStart) +
            updatedTypeContent +
            resultFileContent.slice(typeEnd)
        }
        //

        //
        // Update UpdateInput types for model's own id field
        const updateInputPatterns = [
          `${modelName}UpdateInput`,
          `${modelName}UncheckedUpdateInput`,
        ]
        updateInputPatterns.forEach((inputType) => {
          const inputStart = resultFileContent.search(
            new RegExp(`export type ${inputType} = \\{`),
          )
          if (inputStart === -1) return

          const typeContentStart = resultFileContent.indexOf('{', inputStart) + 1
          let braceCount = 1
          let typeEnd = typeContentStart
          for (let i = typeContentStart; i < resultFileContent.length; i++) {
            if (resultFileContent[i] === '{') braceCount++
            if (resultFileContent[i] === '}') {
              braceCount--
              if (braceCount === 0) {
                typeEnd = i
                break
              }
            }
          }

          const typeContent = resultFileContent.slice(
            typeContentStart,
            typeEnd,
          )
          const updatedTypeContent = typeContent
            .replace(
              new RegExp(`(\\s+)${idField.name}\\?:\\s*string\\b`, 'g'),
              `$1${idField.name}?: ${idTypeName}`,
            )
            .replace(
              new RegExp(`(\\s+)${idField.name}:\\s*string\\b`, 'g'),
              `$1${idField.name}: ${idTypeName}`,
            )

          resultFileContent =
            resultFileContent.slice(0, typeContentStart) +
            updatedTypeContent +
            resultFileContent.slice(typeEnd)
        })
        //

        //
        // Update UpdateWithout* and UncheckedUpdateWithout* types
        const updateWithoutRegex = new RegExp(
          `export type ${modelName}(?:Unchecked)?UpdateWithout\\w+Input = \\{`,
          'g',
        )
        while ((match = updateWithoutRegex.exec(resultFileContent)) !== null) {
          const typeContentStart =
            resultFileContent.indexOf('{', match.index) + 1
          let braceCount = 1
          let typeEnd = typeContentStart
          for (let i = typeContentStart; i < resultFileContent.length; i++) {
            if (resultFileContent[i] === '{') braceCount++
            if (resultFileContent[i] === '}') {
              braceCount--
              if (braceCount === 0) {
                typeEnd = i
                break
              }
            }
          }

          const typeContent = resultFileContent.slice(
            typeContentStart,
            typeEnd,
          )
          const updatedTypeContent = typeContent
            .replace(
              new RegExp(`(\\s+)${idField.name}\\?:\\s*string\\b`, 'g'),
              `$1${idField.name}?: ${idTypeName}`,
            )
            .replace(
              new RegExp(`(\\s+)${idField.name}:\\s*string\\b`, 'g'),
              `$1${idField.name}: ${idTypeName}`,
            )

          resultFileContent =
            resultFileContent.slice(0, typeContentStart) +
            updatedTypeContent +
            resultFileContent.slice(typeEnd)
        }
        //

        //
        // Update where input
        const whereInput = resultFileContent.search(
          `export type ${modelName}WhereInput = {`,
        )
        resultFileContent = replaceAt(
          resultFileContent,
          `${idField.name}: StringFilter<"${modelName}"> | string`,
          `${idField.name}: StringFilter<"${modelName}"> | ${idTypeName}`,
          whereInput,
        )
        resultFileContent = replaceAt(
          resultFileContent,
          `${idField.name}?: StringFilter<"${modelName}"> | string`,
          `${idField.name}?: StringFilter<"${modelName}"> | ${idTypeName}`,
          whereInput,
        )
        //

        //
        // Update where unique input
        const whereUniqueInput = resultFileContent.search(
          `export type ${modelName}WhereUniqueInput = Prisma.AtLeast<{`,
        )
        resultFileContent = replaceAt(
          resultFileContent,
          `  ${idField.name}: string`,
          `  ${idField.name}: ${idTypeName}`,
          whereUniqueInput,
        )
        resultFileContent = replaceAt(
          resultFileContent,
          `  ${idField.name}?: string`,
          `  ${idField.name}?: ${idTypeName}`,
          whereUniqueInput,
        )
        //

        //
        // Handle foreign key fields that reference other models
        const relationFields = model.fields.filter(
          (field) => field.kind === 'object' && field.relationFromFields,
        )

        relationFields.forEach((relationField) => {
          if (!relationField.relationFromFields) { 
            return 
          }

          // Get the related model name from the field type
          const relatedModelName = relationField.type
          const relatedIdType = modelIdTypes.get(relatedModelName)

          if (!relatedIdType) { 
            return 
          }

          // Process each foreign key field in this relation
          relationField.relationFromFields.forEach((foreignKeyFieldName) => {
            // Replace in the model payload
            const payloadSearch = resultFileContent.search(
              `type \\$${modelName}Payload<`,
            )
            resultFileContent = replaceAt(
              resultFileContent,
              `  ${foreignKeyFieldName}: string | null`,
              `  ${foreignKeyFieldName}: ${relatedIdType} | null`,
              payloadSearch,
            )
            resultFileContent = replaceAt(
              resultFileContent,
              `  ${foreignKeyFieldName}: string`,
              `  ${foreignKeyFieldName}: ${relatedIdType}`,
              payloadSearch,
            )

            // Replace global occurrences
            resultFileContent = resultFileContent.replace(
              new RegExp(`${foreignKeyFieldName}: string \\| null`, 'g'),
              `${foreignKeyFieldName}: ${relatedIdType} | null`,
            )
            resultFileContent = resultFileContent.replace(
              new RegExp(`${foreignKeyFieldName}\\?: string \\| null`, 'g'),
              `${foreignKeyFieldName}?: ${relatedIdType} | null`,
            )
            resultFileContent = resultFileContent.replace(
              new RegExp(`${foreignKeyFieldName}: string`, 'g'),
              `${foreignKeyFieldName}: ${relatedIdType}`,
            )
            resultFileContent = resultFileContent.replace(
              new RegExp(`${foreignKeyFieldName}\\?: string`, 'g'),
              `${foreignKeyFieldName}?: ${relatedIdType}`,
            )

            // Handle union types with filters
            resultFileContent = replaceType(
              resultFileContent,
              foreignKeyFieldName,
              relatedIdType,
            )
          })
        })
        //
      })

    fs.writeFileSync(output, resultFileContent)
  },
})
