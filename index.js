#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const stream = require('stream')
const { promisify } = require('util')
const breakpad = require('parse-breakpad')
const got = require('got')
const mkdirp = require('mkdirp')

const symbolFiles = new Map

const cacheDirectory = path.resolve(__dirname, 'cache', 'breakpad_symbols')

async function fetchSymbol(directory, baseUrl, pdb, id, symbolFileName) {
  const url = `${baseUrl}/${encodeURIComponent(pdb)}/${id}/${encodeURIComponent(symbolFileName)}`
  const symbolPath = path.join(directory, pdb, id, symbolFileName)
  const pipeline = promisify(stream.pipeline)

  // ensure path is created
  await mkdirp(path.dirname(symbolPath))

  // decompress the gzip
  try {
    const str = got.stream(url, {
      decompress: true,
      followRedirect: true,
    })
    // create symbol
    await pipeline(str, fs.createWriteStream(symbolPath))
  } catch (err) {
    if (err.message.startsWith('Response code 404')) {
      return false
    } else {
      throw err
    }
  }

  return true
}

const SYMBOL_BASE_URLS = [
  'https://symbols.mozilla.org/try',
  'https://symbols.electronjs.org',
]

async function getSymbolFile(moduleId, moduleName, force) {
  const pdb = moduleName.replace(/^\//, '')
  const symbolFileName = pdb.replace(/(\.pdb)?$/, '.sym')
  const symbolPath = path.join(cacheDirectory, pdb, moduleId, symbolFileName)
  if (fs.existsSync(symbolPath) && !force) {
    return breakpad.parse(fs.createReadStream(symbolPath))
  }
  if (!fs.existsSync(symbolPath) && (!fs.existsSync(path.dirname(symbolPath)) || force)) {
    for (const baseUrl of SYMBOL_BASE_URLS) {
      if (await fetchSymbol(cacheDirectory, baseUrl, pdb, moduleId, symbolFileName))
        return breakpad.parse(fs.createReadStream(symbolPath))
    }
  }
}

async function symbolicateFrame(frame) {
  // ref: https://source.chromium.org/chromium/chromium/src/+/main:third_party/perfetto/src/trace_processor/export_json.cc;l=1413-1420;drc=4e07ae3dd7097bf13b7fff93547d140ac2c8ca83
  const m = /^0x([0-9a-f]+) - (.+) \[([0-9A-F]+)\]$/.exec(frame)
  if (m) {
    const [, offsetHex, moduleName, moduleId] = m
    const offset = parseInt(offsetHex, 16)
    if (!symbolFiles.has(moduleId)) {
      symbolFiles.set(moduleId, getSymbolFile(moduleId, moduleName))
    }
    const symbols = await symbolFiles.get(moduleId)
    if (symbols) {
      const line = symbols.lookup(offset)
      if (line) {
        return `${frame} ${line.func.name}` + (line.file ? ` (${line.file}:${line.line})` : '')
      } else {
        console.log(`could not find ${offset} in ${moduleName}`)
      }
    } else {
      console.log(`could not find symbol file for ${moduleName}`)
    }
  }
  return frame
}

async function symbolicateFrames(framesStr) {
  const frameLines = framesStr.split(/\n/)
  return (await Promise.all(frameLines.map(symbolicateFrame))).join('\n')
}

async function maybeSymbolicate(event) {
  if (event.cat === 'disabled-by-default-cpu_profiler' && event.args && event.args.frames) {
    return {
      ...event,
      args: {
        ...event.args,
        frames: await symbolicateFrames(event.args.frames)
      }
    }
  } else {
    return event
  }
}

async function symbolicate(trace) {
  return {...trace, traceEvents: await Promise.all(trace.traceEvents.map(maybeSymbolicate))}
}

async function cli(argv) {
  if (!argv[2] || !fs.statSync(argv[2]).isFile()) {
    console.error(`Usage: symbolicate-trace <path/to/recording.trace>`)
    console.error(`Output will be written to path/to/recording.trace.symbolicated.`)
    process.exit(1)
  }
  const filename = argv[2]
  console.error('Reading trace...')
  const traceJson = fs.readFileSync(filename)
  console.error('Parsing trace...')
  const trace = JSON.parse(traceJson)
  console.error('Symbolicating...')

  const symbolicated = await symbolicate(trace)

  const outFile = filename + '.symbolicated'
  console.error(`Writing symbolicated trace to '${outFile}'...`)
  fs.writeFileSync(outFile, JSON.stringify(symbolicated))
}

module.exports = { symbolicate, cli }

if (require.main === module) {
  cli(process.argv)
}
