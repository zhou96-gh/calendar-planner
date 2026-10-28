const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

window.readBuiltInColorSchemes = () => {
  const directory = join(__dirname, 'themes');
  return readdirSync(directory)
    .filter((file) => file.endsWith('.json') && file !== 'index.json')
    .sort()
    .map((id) => ({ id, ...JSON.parse(readFileSync(join(directory, id), 'utf8')) }));
};
