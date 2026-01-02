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
