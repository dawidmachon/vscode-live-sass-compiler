//import { WindowPopout, OutputWindow } from "./VscodeExtensions";
import { Helper, IFormat } from "./helper";
import * as compiler from "sass";

export class SassHelper {
    static toSassOptions(format: IFormat): compiler.Options {
        return {
            outputStyle: format.format,
            linefeed: format.linefeed,
            indentType: format.indentType,
            indentWidth: format.indentWidth,
        };
    }

    static compileOne(
        SassPath: string,
        mapFileUri: string,
        options: compiler.Options
    ): { result: compiler.Result | null; errorString: string | null } {
        const generateMap = Helper.getConfigSettings<boolean>("generateMap"),
            data: compiler.Options = {};

        Object.assign(data, options);

        data.file = SassPath;
        data.omitSourceMapUrl = true;
        /*data.logger = {
            warning: (warning: compiler.SassFlag) => {
                OutputWindow.Show(OutputLevel.Warning, "Warning:", warning.formatted.split("\n"));
                WindowPopout.Warn("Live Sass Compiler\n *Warning:* \n" + warning.formatted);
            },
            debug: (debug: compiler.SassFlag) => {
                OutputWindow.Show(OutputLevel.Debug, "Debug info:", debug.formatted.split("\n"));
            },
        };*/

        data.sourceMap = mapFileUri;

        if (!generateMap) {
            data.omitSourceMapUrl = true;
        }

        try {
            return { result: compiler.renderSync(data), errorString: null };
        } catch (err) {
            return { result: null, errorString: err.formatted };
        }
    }
}
