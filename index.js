const fs = require('fs')
const path = require('path')
const breakpad = require('./breakpad')

const symbolFiles = new Map

const cacheDirectory = path.resolve(__dirname, 'cache', 'breakpad_symbols')
const force = false

function fetchSymbol(directory, baseUrl, pdb, id, symbolFileName) {
  const url = `${baseUrl}/${encodeURIComponent(pdb)}/${id}/${encodeURIComponent(symbolFileName)}`
  const symbolPath = path.join(directory, pdb, id, symbolFileName)
  return new Promise((resolve, reject) => {
    // We use curl here in order to avoid having to deal with redirects +
    // gzip + saving to a file ourselves. It would be more portable to
    // handle this in JS rather than by shelling out, though, so TODO.
    const child = require('child_process').spawn('curl', [
      // We don't need progress bars.
      '--silent',

      // The Mozilla symbol server redirects to S3, so follow that
      // redirect.
      '--location',

      // We want to create all the parent directories for the target path,
      // which is breakpad_symbols/foo.pdb/0123456789ABCDEF/foo.sym
      '--create-dirs',

      // The .sym file is gzipped, but minidump_stackwalk needs it
      // uncompressed, so ask curl to ungzip it for us.
      '--compressed',

      // If we get a 404, don't write anything and exit with code 22. The
      // parent directories will still be created, though.
      '--fail',

      // Save the file directly into the cache.
      '--output', symbolPath,

      // This is the URL we want to fetch.
      url
    ])

    child.once('close', (code) => {
      if (code === 0) {
        resolve(true)
      } else {
        if (code === 22) { // 404
          resolve(false)
        } else {
          reject(new Error(`failed to download ${url} (code ${code})`))
        }
      }
    })
  })
}

const SYMBOL_BASE_URLS = [
  'https://symbols.mozilla.org/try',
  'https://symbols.electronjs.org',
]

async function getSymbolFile(moduleId, moduleName) {
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
  const m = /^0x([0-9a-f]+) - (\S+) \[([0-9A-F]+)\]$/.exec(frame)
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

;(async () => {
  if (!process.argv[2] || !fs.statSync(process.argv[2]).isFile()) {
    console.error(`Usage: symbolicate-trace <path/to/recording.trace>`)
    console.error(`Output will be written to path/to/recording.trace.symbolicated.`)
    process.exit(1)
  }
  console.error('Reading trace...')
  const traceJson = fs.readFileSync(process.argv[2])
  console.error('Parsing trace...')
  const trace = JSON.parse(traceJson)
  console.error('Symbolicating...')

  const symbolicated = {...trace, traceEvents: await Promise.all(trace.traceEvents.map(maybeSymbolicate))}

  const outFile = process.argv[2] + '.symbolicated'
  console.error(`Writing symbolicated trace to '${outFile}'...`)
  fs.writeFileSync(outFile, JSON.stringify(symbolicated))
})()
