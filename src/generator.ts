import { generatorHandler, GeneratorOptions } from '@prisma/generator-helper'
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

    let resultFileContent = fs.readFileSync(output, 'utf8')

    const idType = `
    export interface Flavoring<FlavorT> {
      _type?: FlavorT
    }
    export type Flavor<T, FlavorT> = T & Flavoring<FlavorT>
    `

    resultFileContent = idType + resultFileContent

    options.dmmf.datamodel.models.forEach(async (model) => {
      const idField = model.fields.find(
        (field) => field.name === 'id' && field.isId,
      )

      if (idField) {
        const idTypeName = `${model.name}Id`
        const idType = `\nexport type ${idTypeName} = Flavor<string, '__${model.name}Id'>`
        const originalExport = `export type ${model.name} = `

        resultFileContent = resultFileContent.replace(
          originalExport,
          `${idType}\n${originalExport}`,
        )

        const res = resultFileContent.search(`type ${model.name}Payload<`)
        resultFileContent = replaceAt(
          resultFileContent,
          `  ${idField.name}: string`,
          `  ${idField.name}: ${idTypeName}`,
          res,
        )

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

        // projectId?: string | null

        resultFileContent = resultFileContent.replace(
          new RegExp(
            `${stronglyTypedName}\\?:\\sStringFilter\\s\\|\\sstring`,
            'g',
          ),
          `${stronglyTypedName}?: StringFilter | ${idTypeName}`,
        )

        resultFileContent = resultFileContent.replace(
          new RegExp(
            `${stronglyTypedName}\\?:\\sStringFieldUpdateOperationsInput\\s\\|\\string`,
            'g',
          ),
          `${stronglyTypedName}?: StringFieldUpdateOperationsInput | ${idTypeName}`,
        )

        const res1 = resultFileContent.search(
          `export type ${model.name}WhereInput = {`,
        )
        resultFileContent = replaceAt(
          resultFileContent,
          `  ${idField.name}: StringFilter | string`,
          `  ${idField.name}: StringFilter | ${idTypeName}`,
          res1,
        )
        resultFileContent = replaceAt(
          resultFileContent,
          `  ${idField.name}?: StringFilter | string`,
          `  ${idField.name}?: StringFilter | ${idTypeName}`,
          res1,
        )

        const res2 = resultFileContent.search(
          `export type ${model.name}WhereUniqueInput = {`,
        )
        resultFileContent = replaceAt(
          resultFileContent,
          `  ${idField.name}: string`,
          `  ${idField.name}: ${idTypeName}`,
          res2,
        )
        resultFileContent = replaceAt(
          resultFileContent,
          `  ${idField.name}?: string`,
          `  ${idField.name}?: ${idTypeName}`,
          res2,
        )
      }
    })

    fs.writeFileSync(output, resultFileContent)
  },
})
