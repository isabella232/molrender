/**
 * Copyright (c) 2019 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 * @author Jesse Liang <jesse.liang@rcsb.org>
 */

import * as util from 'util'
import createContext = require('gl')
import fs = require('fs')
import { PNG, PNGOptions } from 'pngjs'
import { Canvas3D, Canvas3DParams } from 'molstar/lib/mol-canvas3d/canvas3d';
import InputObserver from 'molstar/lib/mol-util/input/input-observer';
import { ColorTheme } from 'molstar/lib/mol-theme/color';
import { SizeTheme } from 'molstar/lib/mol-theme/size';
import { CartoonRepresentationProvider } from 'molstar/lib/mol-repr/structure/representation/cartoon';
import { MolecularSurfaceRepresentationProvider } from 'molstar/lib/mol-repr/structure/representation/molecular-surface';
import { BallAndStickRepresentationProvider } from 'molstar/lib/mol-repr/structure/representation/ball-and-stick';
import { GaussianSurfaceRepresentationProvider } from 'molstar/lib/mol-repr/structure/representation/gaussian-surface';
import { CarbohydrateRepresentationProvider } from 'molstar/lib/mol-repr/structure/representation/carbohydrate'
import { CIF, CifFrame } from 'molstar/lib/mol-io/reader/cif'
import { trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif';
import { Model, Structure, StructureSymmetry, QueryContext, StructureSelection } from 'molstar/lib/mol-model/structure';
import { ColorNames } from 'molstar/lib/mol-util/color/tables';
import { RepresentationProvider, Representation } from 'molstar/lib/mol-repr/representation';
import { compile } from 'molstar/lib/mol-script/runtime/query/compiler';
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder';
import { StructureSelectionQueries as Q } from 'molstar/lib/mol-plugin/util/structure-selection-helper';


export enum Rep {
    Cartoon = 0,
    BallAndStick = 1,
    Molecular = 2,
    Gaussian = 3
}

function getID(inPath: string) {
    const arr = inPath.split('/')
    return arr[arr.length - 1].split('.')[0]
}

const readFileAsync = util.promisify(fs.readFile);

async function readFile(path: string) {
    if (path.match(/\.bcif$/)) {
        const input = await readFileAsync(path)
        const data = new Uint8Array(input.byteLength);
        for (let i = 0; i < input.byteLength; i++) data[i] = input[i];
        return data;
    } else {
        return readFileAsync(path, 'utf8');
    }


}

export async function openCif(path: string) {
    const data = await readFile(path);
    return parseCif(data);
}

export async function readCifFile(path: string) {
    const parsed = await openCif(path);
    return parsed.blocks[0];
}

async function parseCif(data: string|Uint8Array) {
    const comp = CIF.parse(data);
    const parsed = await comp.run();
    if (parsed.isError) throw parsed;
    return parsed.result;
}

export class RenderAll {

    gl: WebGLRenderingContext
    canvas3d: Canvas3D
    width: number
    height: number
    constructor(w: number, h: number) {
        this.width = w
        this.height = h

        this.gl = createContext(this.width, this.height, {
            alpha: false,
            antialias: true,
            depth: true,
            preserveDrawingBuffer: true
        })
        const input = InputObserver.create()
        this.canvas3d = Canvas3D.create(this.gl, input, {
            multiSample: {
                mode: 'on',
                sampleLevel: 3
            },
            renderer: {
                ...Canvas3DParams.renderer.defaultValue,
                lightIntensity: 0,
                ambientIntensity: 1,
                backgroundColor: ColorNames.white
            },
            postprocessing: {
                ...Canvas3DParams.postprocessing.defaultValue,
                occlusionEnable: true,
                outlineEnable: true
            }
        })
        this.canvas3d.animate()

    }

    async getModels(frame: CifFrame) {
        return await trajectoryFromMmCIF(frame).run();
    }

    async getStructure(model: Model) {
        return Structure.ofModel(model);
    }

    async renderAsm(modIndex: number, asmIndex: number, models: readonly Model[], outPath: string, id: string) {
        this.canvas3d.clear()
        const reprCtx = {
            wegbl: this.canvas3d.webgl,
            colorThemeRegistry: ColorTheme.createRegistry(),
            sizeThemeRegistry: SizeTheme.createRegistry()
        }

        try {
            let structure = await this.getStructure(models[modIndex])

            const asmName = models[modIndex].symmetry.assemblies[asmIndex].id
            console.log(`Rendering ${id} model ${models[modIndex].modelNum} assembly ${asmName}...`)

            let wholeStructure = await this.getStructure(models[modIndex])
            const task = StructureSymmetry.buildAssembly(wholeStructure, models[modIndex].symmetry.assemblies[asmIndex].id)
            wholeStructure = await task.run()

            const carbRepr = CarbohydrateRepresentationProvider.factory(reprCtx, CarbohydrateRepresentationProvider.getParams)

            carbRepr.setTheme({
                color: reprCtx.colorThemeRegistry.create('carbohydrate-symbol', { structure: wholeStructure }),
                size: reprCtx.sizeThemeRegistry.create('uniform', { structure: wholeStructure })
            })
            await carbRepr.createOrUpdate({ ...CarbohydrateRepresentationProvider.defaultValues, quality: 'auto' }, wholeStructure).run()
            this.canvas3d.add(carbRepr)

            // TODO: base repr off the amount of things
            console.log(structure.polymerUnitCount)
            const repr = CartoonRepresentationProvider.factory(reprCtx, CartoonRepresentationProvider.getParams)

            repr.setTheme({
                color: reprCtx.colorThemeRegistry.create('polymer-id', { structure }),
                size: reprCtx.sizeThemeRegistry.create('uniform', { structure })
            })
            await repr.createOrUpdate({ ... CartoonRepresentationProvider.defaultValues, quality: 'auto' }, structure).run()

            this.canvas3d.add(repr)

            const expression = MS.struct.modifier.union([
                MS.struct.combinator.merge([ Q.ligandPlusConnected, Q.branchedConnectedOnly ])
            ])
            const query = compile<StructureSelection>(expression)
            const selection = query(new QueryContext(wholeStructure))
            structure = StructureSelection.unionStructure(selection)

            const ligandRepr = BallAndStickRepresentationProvider.factory(reprCtx, BallAndStickRepresentationProvider.getParams)

            repr.setTheme({
                color: reprCtx.colorThemeRegistry.create('element-symbol', { structure }),
                size: reprCtx.sizeThemeRegistry.create('uniform', { structure })
            })
            await ligandRepr.createOrUpdate({ ...BallAndStickRepresentationProvider.defaultValues, quality: 'auto' }, structure).run()
            this.canvas3d.add(ligandRepr)

            this.canvas3d.resetCamera()

            setTimeout(() => {
                const pixelData = this.canvas3d.getPixelData('color')
                const options: PNGOptions = {width: this.width, height: this.height}
                const generatedPng = new PNG(options)
                generatedPng.data = Buffer.from(pixelData.array)
                let imagePathName = `${outPath}/${folderName}/${id}/${id}_model-${models[modIndex].modelNum}-assembly-${asmName}.png`
                generatedPng.pack().pipe(fs.createWriteStream(imagePathName)).on('finish', () => {
                    console.log('Finished.')
                    process.exit()
                })
            }, 50)

        } catch (e) {
            console.error(e)
            process.exit(1)
        }

    }

    async renderMod(modIndex: number, models: readonly Model[], outPath: string, id: string) {
        const folderName = `${id[1]}${id[2]}`
        this.canvas3d.clear()
        const reprCtx = {
            wegbl: this.canvas3d.webgl,
            colorThemeRegistry: ColorTheme.createRegistry(),
            sizeThemeRegistry: SizeTheme.createRegistry()
        }

        try {
            if (!fs.existsSync(outPath + '/' + folderName)) {
                fs.mkdirSync(outPath + '/' + folderName)
            }

            if (!fs.existsSync(`${outPath}/${folderName}/${id}`)) {
                fs.mkdirSync(`${outPath}/${folderName}/${id}`)
            }

            let structure = await this.getStructure(models[modIndex])

            console.log(`Rendering ${id} model ${models[modIndex].modelNum}...`)

            let wholeStructure = await this.getStructure(models[modIndex])

            const carbRepr = CarbohydrateRepresentationProvider.factory(reprCtx, CarbohydrateRepresentationProvider.getParams)

            carbRepr.setTheme({
                color: reprCtx.colorThemeRegistry.create('carbohydrate-symbol', { structure: wholeStructure }),
                size: reprCtx.sizeThemeRegistry.create('uniform', { structure: wholeStructure })
            })
            await carbRepr.createOrUpdate({ ...CarbohydrateRepresentationProvider.defaultValues, quality: 'auto' }, wholeStructure).run()
            this.canvas3d.add(carbRepr)

            // TODO: base repr off the amount of things
            console.log(structure.polymerUnitCount)
            const repr = CartoonRepresentationProvider.factory(reprCtx, CartoonRepresentationProvider.getParams)

            repr.setTheme({
                color: reprCtx.colorThemeRegistry.create('polymer-id', { structure }),
                size: reprCtx.sizeThemeRegistry.create('uniform', { structure })
            })
            await repr.createOrUpdate({ ... CartoonRepresentationProvider.defaultValues, quality: 'auto' }, structure).run()

            this.canvas3d.add(repr)

            const expression = MS.struct.modifier.union([
                MS.struct.combinator.merge([ Q.ligandPlusConnected, Q.branchedConnectedOnly ])
            ])
            const query = compile<StructureSelection>(expression)
            const selection = query(new QueryContext(wholeStructure))
            structure = StructureSelection.unionStructure(selection)

            const ligandRepr = BallAndStickRepresentationProvider.factory(reprCtx, BallAndStickRepresentationProvider.getParams)

            repr.setTheme({
                color: reprCtx.colorThemeRegistry.create('element-symbol', { structure }),
                size: reprCtx.sizeThemeRegistry.create('uniform', { structure })
            })
            await ligandRepr.createOrUpdate({ ...BallAndStickRepresentationProvider.defaultValues, quality: 'auto' }, structure).run()
            this.canvas3d.add(ligandRepr)

            this.canvas3d.resetCamera()

            setTimeout(() => {
                const pixelData = this.canvas3d.getPixelData('color')
                const options: PNGOptions = {width: this.width, height: this.height}
                const generatedPng = new PNG(options)
                generatedPng.data = Buffer.from(pixelData.array)
                let imagePathName = `${outPath}/${folderName}/${id}/${id}_model-${models[modIndex].modelNum}-assembly-${asmName}.png`
                generatedPng.pack().pipe(fs.createWriteStream(imagePathName)).on('finish', () => {
                    console.log('Finished.')
                    process.exit()
                })
            }, 50)

        } catch (e) {
            console.error(e)
            process.exit(1)
        }

    }

    async renderChn(chnName: string, inPath: string, outPath: string, maxSize: number) {
        const reprCtx = {
            wegbl: this.canvas3d.webgl,
            colorThemeRegistry: ColorTheme.createRegistry(),
            sizeThemeRegistry: SizeTheme.createRegistry()
        }
        const id = getID(inPath)
        const folderName = `${id[1]}${id[2]}`

        try {
            if (!fs.existsSync(`${outPath}/${folderName}`)) {
                fs.mkdirSync(`${outPath}/${folderName}`)
            }

            if (!fs.existsSync(`${outPath}/${folderName}/${id}`)) {
                fs.mkdirSync(`${outPath}/${folderName}/${id}`)
            }

            const cif = await readCifFile(inPath)
            const models = await this.getModels(cif as CifFrame)

            let wholeStructure = await this.getStructure(models[0])

            console.log(`Rendering ${id} chain ${chnName}...`)

            const expression = MS.struct.generator.atomGroups({
                'chain-test': MS.core.rel.eq([MS.ammp('label_asym_id'), chnName])
            })
            const query = compile<StructureSelection>(expression)
            const selection = query(new QueryContext(wholeStructure))
            const structure = StructureSelection.unionStructure(selection)

            if (structure.elementCount > maxSize) {
                console.log(`Not rendered because polymer too large: ${structure.elementCount} > ${maxSize}`)
                process.exit()
            }

            const repr = BallAndStickRepresentationProvider.factory(reprCtx, BallAndStickRepresentationProvider.getParams)
            const provider = BallAndStickRepresentationProvider

            // console.log(`${chnName} ${structure.elementCount}`)

            repr.setTheme({
                color: reprCtx.colorThemeRegistry.create('element-symbol', { structure }),
                size: reprCtx.sizeThemeRegistry.create('uniform', { structure })
            })
            await repr.createOrUpdate({ ...provider.defaultValues, quality: 'auto' }, structure).run()

            this.canvas3d.add(repr)
            this.canvas3d.resetCamera()

            setTimeout(() => {
                const pixelData = this.canvas3d.getPixelData('color')
                const options: PNGOptions = {width: this.width, height: this.height}
                const generatedPng = new PNG(options)
                generatedPng.data = Buffer.from(pixelData.array)

                let imagePathName = `${outPath}/${folderName}/${id}/${id}_chain-${chnName}.png`
                generatedPng.pack().pipe(fs.createWriteStream(imagePathName)).on('finish', () => {
                    console.log('Finished.')
                    process.exit()
                })
            }, 50)


        } catch (e) {
            console.error(e)
            process.exit(1)
        }

    }

    async renderComb(modIndex: number, asmIndex: number, inPath: string, outPath: string) {
        const cif = await readCifFile(inPath)
        const models = await this.getModels(cif as CifFrame)
        const id = getID(inPath)

        const folderName = `${id[1]}${id[2]}`
    
        try {
            if (!fs.existsSync(outPath + '/' + folderName)) {
                fs.mkdirSync(outPath + '/' + folderName)
            }

            if (!fs.existsSync(`${outPath}/${folderName}/${id}`)) {
                fs.mkdirSync(`${outPath}/${folderName}/${id}`)
            }
        }

        this.renderAsm(modIndex, asmIndex, models, outPath, id)
    }

    async renderMod2() {

    }

}

export async function getArrLengths(index: number, inPath: string) {
    try {
        const cif = await readCifFile(inPath)
        const models = await trajectoryFromMmCIF(cif as CifFrame).run()
        console.log(models.length)
        console.log(models[index].symmetry.assemblies.length)
    } catch (e) {
        console.log(e)
    }
}

export async function getChnNames(inPath: string) {
    try {
        const cif = await readCifFile(inPath)
        const models = await trajectoryFromMmCIF(cif as CifFrame).run()

        const { entities } = models[0]
        const { label_asym_id, label_entity_id } = models[0].atomicHierarchy.chains
        for (let i = 0, il = label_asym_id.rowCount; i < il; ++i) {
            const eI = entities.getEntityIndex(label_entity_id.value(i))
            if (entities.data.type.value(eI) === 'polymer') {
                console.log(label_asym_id.value(i))
            }

        }
    } catch (e) {
        console.log(e)
    }
}

export async function getArrLengthsPy(index: number, inPath: string) {
    try {
        const cif = await readCifFile(inPath)
        const models = await trajectoryFromMmCIF(cif as CifFrame).run()
        const val = `{ modlen: ${models.length}, asmlen: ${models[index].symmetry.assemblies.length}}`
        return val
    } catch (e) {
        console.log(e)
    }
}

export async function getChnNamesPy(inPath: string) {
    try {
        const cif = await readCifFile(inPath)
        const models = await trajectoryFromMmCIF(cif as CifFrame).run()

        const { entities } = models[0]
        const { label_asym_id, label_entity_id } = models[0].atomicHierarchy.chains
        for (let i = 0, il = label_asym_id.rowCount; i < il; ++i) {
            const eI = entities.getEntityIndex(label_entity_id.value(i))
            if (entities.data.type.value(eI) === 'polymer') {
                return (label_asym_id.value(i))
            }

        }
    } catch (e) {
        console.log(e)
    }
}

// const render = new RenderAll(2000, 1500)

// render.renderComb('examples/1oh3.cif', 'images')

// getChnNames('examples/3pqr.cif')
// render.renderChn('A', 'examples/3pqr.cif', 'images', 3)
// render.renderMod(0, 'examples/3pqr.cif', 'images', 0)

