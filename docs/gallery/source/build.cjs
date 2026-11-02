// One command to refresh the Devpost gallery.
//   node docs/gallery/source/build.cjs            re-capture raid-scene frames, then re-render every image
//   node docs/gallery/source/build.cjs app        re-capture product screens from https://localhost:4317, then render
//   node docs/gallery/source/build.cjs all        scene + app + footage frames, then render
//   node docs/gallery/source/build.cjs render     render only
// Scene frames come from the dev scene lab (default http://127.0.0.1:4321, override with LAB=http://127.0.0.1:4322);
// which moments are captured, and at what time, is set in capture/scene-moments.json.
const { execFileSync } = require('child_process'), path = require('path');
const here = __dirname, mode = process.argv[2] || 'scene';
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: here });
if (mode === 'scene' || mode === 'all') run('node', [path.join('capture', 'capture-scene.cjs'), process.env.LAB || 'http://127.0.0.1:4321']);
if (mode === 'app' || mode === 'all') run('node', [path.join('capture', 'capture-app.cjs'), process.env.APP || 'https://localhost:4317']);
if (mode === 'all') run('sh', [path.join('capture', 'capture-footage.sh')]);
run('node', ['render.cjs']);
