const { spawnSync } = require('node:child_process');
const path = require('node:path');

const packageJson = require('../package.json');

const codeCommand = process.platform === 'win32' ? 'code.cmd' : 'code';
const staleExtensionIds = [
	'local.browse-supabase-migrations',
	'p0l0us.browse-supabase-migrations',
];
const vsixPath = path.resolve(
	__dirname,
	'..',
	`browse-supabase-migrations-${packageJson.version}.vsix`,
);

for (const extensionId of staleExtensionIds) {
	runCode(['--uninstall-extension', extensionId], { allowFailure: true });
}

runCode(['--install-extension', vsixPath, '--force']);
runCode(['--list-extensions', '--show-versions'], {
	filterOutput: /browse-supabase-migrations/i,
});

function runCode(args, options = {}) {
	const result = spawnSync(codeCommand, args, {
		encoding: 'utf8',
		stdio: options.filterOutput ? 'pipe' : 'inherit',
	});

	if (options.filterOutput) {
		const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
			.split(/\r?\n/)
			.filter((line) => options.filterOutput.test(line))
			.join('\n');

		if (output) {
			console.log(output);
		}
	}

	if (result.error) {
		if (options.allowFailure) {
			return;
		}

		throw result.error;
	}

	if (result.status !== 0 && !options.allowFailure) {
		process.exit(result.status ?? 1);
	}
}