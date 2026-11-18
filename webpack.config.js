import { resolve as _resolve, relative as _relative, dirname as _dirname, isAbsolute as _isAbsolute } from 'path';
import TerserPlugin from 'terser-webpack-plugin';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = _dirname(__filename);
const ST_PUBLIC_ROOT = _resolve(__dirname, '../../../../');
const EXTENSION_ROOT = _resolve(__dirname); 

const serverConfig = {
    devtool: 'source-map',
    target: 'browserslist',
    entry: './src/index.ts',
    output: {
        path: _resolve('.', 'dist'),
        filename: 'index.js',
        libraryTarget: 'module',
        libraryExport: 'default',
        // Standardize paths within source maps to ensure that builds across different environments produce identical source maps.
        devtoolModuleFilenameTemplate: info => {
            // Use relative paths to avoid discrepancies in absolute paths across different operating systems.
            const relativePath = _relative(__dirname, info.absoluteResourcePath);
            // Use forward slashes consistently to avoid differences in path separators between Windows and Unix.
            return 'webpack:///' + relativePath.replace(/\\/g, '/');
        },
    },
    resolve: {
        extensions: ['.ts', '.tsx', '.js'],
        alias: {
            '@': _resolve(__dirname, 'src'),
            'react': 'preact/compat',
            'react-dom': 'preact/compat',
        }
    },
    module: {
        rules: [
            {
                test: /\.(ts|tsx|js)$/,
                use: [
                    {
                        loader: 'babel-loader',
                        options: {
                            sourceMaps: true,
                        },
                    }
                ],
                exclude: /node_modules/,
            },
        ],
    },
    experiments: {
        outputModule: true,
    },
    optimization: {
        minimizer: [
            new TerserPlugin({
                extractComments: false,
                terserOptions: {
                    format: {
                        comments: false,
                    },
                },
            }),
        ],
        splitChunks: false,
        runtimeChunk: false,
    },
    plugins: [],
    externals: function({ context, request }, callback) {
        // 1. Handle explicit @st/ aliases
        if (request.startsWith('@st/')) {
            let webPath = request.replace('@st/', '/');
            // Fix file extensions
            if(!webPath.endsWith('.js'))
                webPath += '.js';
            return callback(null, `module ${webPath}`);
        }

        // 2. If it’s a standard third-party library import (i.e., one that doesn’t start with `.`), such as `import 'yaml'`,
        // or if the path lies within the plugin’s own directory (including `node_modules` and `src`),
        // then these must be bundled.
        if (!request.startsWith('.') && !_isAbsolute(request)) {
            // These are libraries from `node_modules`, to be bundled by webpack.
            return callback();
        }

        // 3. Handling relative path imports
        const absPath = _resolve(context, request);
        
        // Check whether this file is within our plugin directory.
        if (absPath.startsWith(EXTENSION_ROOT)) {
            // Include it in the build from within the plugin directory (either `src` or the plugin's own `node_modules`).
            return callback();
        }

        // 4. If the file is outside the plugin directory but within the ST public directory
        if (absPath.startsWith(ST_PUBLIC_ROOT)) {
            // Calculate the path relative to 'ST public' and convert it into an absolute web path.
            let relativeWebPath = _relative(ST_PUBLIC_ROOT, absPath).replace(/\\/g, '/');
            if (!relativeWebPath.startsWith('/')) {
                relativeWebPath = '/' + relativeWebPath;
            }
            return callback(null, `module ${relativeWebPath}`);
        }

        // Other
        callback();
    },
};

export default [serverConfig];
