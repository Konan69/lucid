const NodePath = require('node:path')
const NodeURL = require('node:url')

module.exports = {
  hooks: {
    updateConfig(config) {
      const guard = NodeURL.pathToFileURL(
        NodePath.join(__dirname, 'scripts/compiler-guard.mjs'),
      ).href
      const preload = `--import=${guard}`
      const current = config.nodeOptions ?? process.env.NODE_OPTIONS ?? ''
      const nodeOptions = current.includes(preload) ? current : `${current} ${preload}`.trim()
      return { ...config, nodeOptions }
    },
  },
}
