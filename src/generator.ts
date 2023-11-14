import {
  DMMF,
  generatorHandler,
  GeneratorOptions,
} from '@prisma/generator-helper'
import { logger } from '@prisma/internals'
import { GENERATOR_NAME } from './constants'
import fs from 'fs'

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

    const idType = `
    export interface Flavoring<FlavorT> {
      _type?: FlavorT
    }
    export type Flavor<T, FlavorT> = T & Flavoring<FlavorT>
    `

    let resultFileContent = idType + fs.readFileSync(output, 'utf8')

    options.dmmf.datamodel.models
      .map((model) => {
        const idField = model.fields.find(
          ({ name, isId }) => name === 'id' && isId,
        )

        return { idField, modelName: model.name }
      })
      .filter(
        (fieldInfo): fieldInfo is { modelName: string; idField: DMMF.Field } =>
          !!fieldInfo.idField,
      )
      .forEach(async ({ idField, modelName }) => {
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

        const res = resultFileContent.search(`type ${modelName}Payload<`)
        resultFileContent = replaceAt(
          resultFileContent,
          `  ${idField.name}: string`,
          `  ${idField.name}: ${idTypeName}`,
          res,
        )

        //
        // Replace by name (e.g. "userId") in code
        const stronglyTypedName = `${
          idTypeName.charAt(0).toLowerCase() + idTypeName.slice(1)
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
      })

    fs.writeFileSync(output, resultFileContent)
  },
})
