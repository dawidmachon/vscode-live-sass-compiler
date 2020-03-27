'use strict';

import * as autoprefixer from 'autoprefixer';
import * as glob from 'glob';
import * as path from 'path';
import * as postcss from 'postcss';
import * as vscode from 'vscode';

import { FileHelper, IFileResolver } from './FileHelper';
import { Helper, IFormat } from './helper';
import { OutputWindow, WindowPopout } from './VscodeWindow';
import { SassHelper } from './SassCompileHelper';
import { StatusBarUi } from './StatubarUi'

export class AppModel {

    isWatching: boolean;

    constructor() {
        this.isWatching = Helper.getConfigSettings<boolean>('watchOnLaunch');

        StatusBarUi.init(this.isWatching);
    }

    StartWatching() {
        if (this.isWatching) {
            WindowPopout.Inform('Already watching...');
        }
        else {
            this.isWatching = !this.isWatching;
            this.compileAllFiles();
        }
    }

    StopWatching() {
        if (this.isWatching) {
            this.isWatching = !this.isWatching;
            this.revertUIToWatchingStatusNow();
        }
        else {
            WindowPopout.Inform('Not watching...');
        }
    }

    openOutputWindow() {
        OutputWindow.Show(null, null, true);
    }

    static get basePath(): string {
        return vscode.workspace.rootPath || path.basename(vscode.window.activeTextEditor.document.fileName);
    }

    private getCssStyle(format?: string) {
        return SassHelper.targetCssFormat(format || 'expanded');
    }

    //#region Compilation functions

    //#region Public

    /**
     * Compile all files.
     */
    async compileAllFiles() {
        try {
            StatusBarUi.working();

            const showOutputWindow = Helper.getConfigSettings<boolean>('showOutputWindow');

            await this.GenerateAllCssAndMap(showOutputWindow);
        }
        catch (err) {
            // TODO: Research error logging
        }

        this.revertUIToWatchingStatusNow()
    }

    /**
     * Compiles the currently active file
     */
    async compileCurrentFile() {
        const showOutputWindow = Helper.getConfigSettings<boolean>('showOutputWindow');

        try {
            if (!vscode.window.activeTextEditor) {
                StatusBarUi.customMessage("No file open", "No file is open, ensure a file is open in the editor window", "warning");
                OutputWindow.Show('No active file', ["There isn't an active editor window to process"], showOutputWindow)

                this.revertUIToWatchingStatus();

                return;
            }

            const sassPath = vscode.window.activeTextEditor.document.uri.fsPath;

            if (!this.isSassFile(vscode.window.activeTextEditor.document.uri.fsPath)) {
                if (this.isSassFile(vscode.window.activeTextEditor.document.uri.fsPath, true))
                    StatusBarUi.customMessage("Can't process partial Sass", "The file currently open in the editor window is a partial sass file, these aren't processed singly", "warning");
                else
                    StatusBarUi.customMessage("Not a Sass file", "The file currently open in the editor window isn't a sass file", "warning");

                this.revertUIToWatchingStatus();

                return;
            }

            const formats = Helper.getConfigSettings<IFormat[]>('formats');

            StatusBarUi.working("Processing single file...");
            OutputWindow.Show('Processing the current file', [`Path: ${sassPath}`], showOutputWindow)

            const promises = [];
            formats.forEach(format => { // Each format
                const options = this.getCssStyle(format.format);
                const cssMapUri = this.generateCssAndMapUri(sassPath, format.savePath, format.extensionName);
                promises.push(this.GenerateCssAndMap(sassPath, cssMapUri.css, cssMapUri.map, options));
            });

            await Promise.all(promises);

            StatusBarUi.compilationSuccess(this.isWatching);
        }
        catch (reason) {
            OutputWindow.Show('Error in processing', [reason.name, reason.message, reason.stack], showOutputWindow)
        }
    }

    /**
     * Compiles the file that has just been saved
     */
    async compileOnSave() {
        if (!this.isWatching)
            return;

        const showOutputWindow = Helper.getConfigSettings<boolean>('showOutputWindow');

        try {
            const currentFile = vscode.window.activeTextEditor.document.fileName;

            if (!this.isSassFile(currentFile, true))
                return;

            if (await this.isSassFileExcluded(vscode.window.activeTextEditor.document.uri.fsPath))
                return;

            OutputWindow.Show('Change detected...', [path.basename(currentFile)], showOutputWindow);

            if (this.isSassFile(currentFile)) {
                const
                    formats = Helper.getConfigSettings<IFormat[]>('formats'),
                    sassPath = currentFile,
                    promises: Promise<Boolean>[] = [];

                formats.forEach(format => { // Each format
                    const
                        options = this.getCssStyle(format.format),
                        cssMapPath = this.generateCssAndMapUri(sassPath, format.savePath, format.extensionName);

                    promises.push(this.GenerateCssAndMap(sassPath, cssMapPath.css, cssMapPath.map, options))
                });

                await Promise.all(promises);
            }
            else { // Partial Or not
                await this.GenerateAllCssAndMap(showOutputWindow);
            }
        }
        catch (reason) {
            OutputWindow.Show('Error in processing', [reason.name, reason.message], showOutputWindow);
        }

        this.revertUIToWatchingStatus();
    }

    //#endregion Public

    //#region Private

    /**
     * To Generate one One Css & Map file from Sass/Scss
     * @param SassPath Sass/Scss file URI (string)
     * @param targetCssUri Target CSS file URI (string)
     * @param mapFileUri Target MAP file URI (string)
     * @param options - Object - It includes target CSS style and some more.
     */
    private async GenerateCssAndMap(SassPath: string, targetCssUri: string, mapFileUri: string, options) {
        const
            generateMap = Helper.getConfigSettings<boolean>('generateMap'),
            autoprefixerTarget = Helper.getConfigSettings<Array<string>>('autoprefix'),
            showOutputWindow = Helper.getConfigSettings<boolean>('showOutputWindow'),
            result = await SassHelper.instance.compileOne(SassPath, options);

        if (result.firendlyError !== undefined) {
            OutputWindow.Show('Compilation Error', [result.firendlyError], showOutputWindow);
            StatusBarUi.compilationError(this.isWatching);

            if (!showOutputWindow)
                vscode.window.setStatusBarMessage(result.firendlyError.split('\n')[0], 4500);

            return false;
        }

        const
            promises: Promise<IFileResolver>[] = [],
            mapFileTag = `/*# sourceMappingURL=${path.basename(targetCssUri)}.map */`;

        if (autoprefixerTarget) {
            result.css = await this.autoprefix(result.css, autoprefixerTarget);
        }

        if (generateMap) {
            promises.push(FileHelper.Instance.writeToOneFile(targetCssUri, `${result.css}${mapFileTag}`));
            const map = this.GenerateMapObject(result.map, targetCssUri);
            promises.push(FileHelper.Instance.writeToOneFile(mapFileUri, JSON.stringify(map, null, 4)));
        }
        else {
            promises.push(FileHelper.Instance.writeToOneFile(targetCssUri, `${result.css}`));
        }

        const fileResolvers = await Promise.all(promises);
        OutputWindow.Show('Generated :', null, false, false);
        StatusBarUi.compilationSuccess(this.isWatching);
        fileResolvers.forEach(fileResolver => {
            if (fileResolver.Exception) {
                OutputWindow.Show('Error:', [
                    fileResolver.Exception.errno.toString(),
                    fileResolver.Exception.path,
                    fileResolver.Exception.message
                ], true);
                console.error('error :', fileResolver);
            }
            else {
                OutputWindow.Show(null, [fileResolver.FileUri], false, false);
            }
        });

        OutputWindow.Show(null, null, false, true);

        return true;
    }

    /**
     * To compile all Sass/scss files
     * @param popUpOutputWindow To control output window.
     */
    private async GenerateAllCssAndMap(popUpOutputWindow: Boolean) {
        const
            formats = Helper.getConfigSettings<IFormat[]>('formats'),
            promises: Promise<Boolean>[] = [],
            sassPaths: string[] = await this.getSassFiles();

        OutputWindow.Show('Compiling Sass/Scss Files: ', sassPaths, popUpOutputWindow);

        sassPaths.forEach((sassPath) => {
            formats.forEach(format => { // Each format
                const
                    options = this.getCssStyle(format.format),
                    cssMapUri = this.generateCssAndMapUri(sassPath, format.savePath, format.extensionName);

                promises.push(this.GenerateCssAndMap(sassPath, cssMapUri.css, cssMapUri.map, options));
            });
        });

        return Promise.all(promises);
    }

    /**
     * Generate Map Object
     * @param mapObject Generated Map object form Sass.js library
     * @param targetCssUri Css URI
     */
    private GenerateMapObject(mapObject, targetCssUri: string) {
        const map = {
            'version': 3,
            'mappings': '',
            'sources': [],
            'names': [],
            'file': ''
        };

        map.mappings = mapObject.mappings;
        map.file = path.basename(targetCssUri);

        mapObject.sources.forEach((source: string) => {
            // path starts with ../saas/<path> or ../< path>
            if (source.startsWith('../sass/')) {
                source = source.substring('../sass/'.length);
            }
            else if (source.startsWith('../')) {
                source = source.substring('../'.length);
            }
            if (process.platform !== 'win32') {
                source = '/' + source; // for linux, maybe for MAC too
            }

            let testpath = path.relative(path.dirname(targetCssUri), source);
            testpath = testpath.replace(/\\/gi, '/');
            map.sources.push(testpath);
        });

        return map;
    }

    private generateCssAndMapUri(filePath: string, savePath: string, _extensionName?: string) {
        const extensionName = _extensionName || '.css'; // Helper.getConfigSettings<string>('extensionName');

        // If SavePath is NULL, CSS uri will be same location of SASS.
        if (savePath) {
            try {
                const workspaceRoot = vscode.workspace.rootPath;
                let generatedUri = null;

                if (savePath.startsWith('~'))
                    generatedUri = path.join(path.dirname(filePath), savePath.substring(1));
                else
                    generatedUri = path.join(workspaceRoot, savePath);

                FileHelper.Instance.MakeDirIfNotAvailable(generatedUri);

                filePath = path.join(generatedUri, path.basename(filePath));
            }
            catch (err) {
                console.log(err);

                OutputWindow.Show('Error:', [
                    err.errno.toString(),
                    err.path,
                    err.message
                ], true);

                throw Error('Something Went Wrong.');
            }
        }

        const cssUri = filePath.substring(0, filePath.lastIndexOf('.')) + extensionName;

        return {
            css: cssUri,
            map: cssUri + '.map'
        };
    }

    /**
     * Autoprefixes CSS properties
     *
     * @param css String representation of CSS to transform
     * @param target What browsers to be targeted, as supported by [Browserslist](https://github.com/ai/browserslist)
     */
    private async autoprefix(css: string, browsers: Array<string>): Promise<string> {
        const
            showOutputWindow = Helper.getConfigSettings<boolean>('showOutputWindow'),
            prefixer = postcss([
                autoprefixer({
                    overrideBrowserslist: browsers,
                    grid: true,

                })
            ]);

        return await prefixer
            .process(css, {
                from: 'app.sass.css',
                to: 'app.css',
                map: { inline: false }
            })
            .then(res => {
                res.warnings().forEach(warn => {
                    OutputWindow.Show('Autoprefix Error', [warn.text], showOutputWindow);
                });
                return res.css;
            });
    }

    //#endregion Private

    //#endregion Public compilation functions

    //#region UI manipulation functions

    private revertUIToWatchingStatus() {
        const t = this;
        setTimeout(function () {
            t.revertUIToWatchingStatusNow();
        }, 3000);
    }

    private revertUIToWatchingStatusNow() {
        const showOutputWindow = Helper.getConfigSettings<boolean>('showOutputWindow');

        if (this.isWatching) {
            StatusBarUi.watching();
            OutputWindow.Show('Watching...', null, showOutputWindow);
        }
        else {
            StatusBarUi.notWatching();
            OutputWindow.Show('Not Watching...', null, showOutputWindow);
        }
    }

    //#endregion UI manipulation functions

    //#region Fetch & check SASS functions

    isSassFile(pathUrl: string, partialSass = false): boolean {
        const filename = path.basename(pathUrl);
        return (partialSass || !filename.startsWith('_')) && (filename.endsWith('sass') || filename.endsWith('scss'))
    }

    private async isSassFileExcluded(sassPath: string) {
        const files = await this.getSassFiles('**/*.s[a|c]ss', true);
        return files.find(e => e === sassPath) ? false : true;
    }

    private getSassFiles(queryPattern = '**/[^_]*.s[a|c]ss', isQueryPatternFixed = false): Thenable<string[]> {
        const
            excludedList = Helper.getConfigSettings<string[]>('excludeList'),
            includeItems = Helper.getConfigSettings<string[] | null>('includeItems'),
            options = {
                ignore: excludedList,
                mark: true,
                cwd: AppModel.basePath
            };

        if (!isQueryPatternFixed && includeItems && includeItems.length) {
            if (includeItems.length === 1) {
                queryPattern = includeItems[0];
            }
            else {
                queryPattern = `{${includeItems.join(',')}}`;
            }
        }

        return new Promise(resolve => {
            glob(queryPattern, options, (err, files: string[]) => {
                if (err) {
                    OutputWindow.Show('Error whilst searching for files', [err.code + " " + err.errno.toString(), err.message, err.stack], true);
                    resolve([]);
                    return;
                }
                const filePaths =
                    files.filter(file => this.isSassFile(file))
                        .map(file => path.join(AppModel.basePath, file));
                return resolve(filePaths || []);
            });
        })
    }

    //#endregion Fetch & check SASS functions

    dispose() {
        StatusBarUi.dispose();
        OutputWindow.dispose();
    }
}
