'use strict';

const _ = require('lodash');
const babel = require('gulp-babel');
const compileSoy = require('metal-tools-soy/lib/pipelines/compileSoy');
const data = require('gulp-data');
const filter = require('gulp-filter');
const frontMatter = require('gulp-front-matter');
const fs = require('fs-extra');
const globby = require('globby');
const path = require('path');
const {Component} = require('metal-component');

// Instantiate jsdom globals
// Note: this can be removed once the Marble components have been
// updated to work with SSR
require('jsdom-global')();

const baseInject = require('../pipelines/base_inject');
const bundle = require('../pipelines/bundle');
const getTemplate = require('../get_template');
const handleError = require('../handle_error');
const layout = require('../pipelines/layout');
const markdown = require('../pipelines/markdown');
const tokenReplace = require('../pipelines/token_replace');

const TEMP_DIR = '.temp/task/metal';

const TEMP_DIR_SITE = TEMP_DIR + '/site';

const TEMP_DIR_SOY = TEMP_DIR + '/soy';

module.exports = function(options) {
	const gulp = options.gulp;
	const pathDest = options.pathDest;
	const pathSrc = options.pathSrc;
	const metalComponents = options.metalComponents;
	const runSequence = options.runSequence;
	const taskPrefix = options.taskPrefix;
	const util = options.util;

	gulp.task(taskPrefix + 'metal', function(cb) {
		runSequence(
			[taskPrefix + 'metal:prep:partials', taskPrefix + 'metal:prep:layouts'],
			taskPrefix + 'metal:prep:base-layout',
			taskPrefix + 'metal:prep:pages',
			taskPrefix + 'metal:prep:page-components',
			taskPrefix + 'metal:render:soy',
			taskPrefix + 'metal:prep:transpile',
			taskPrefix + 'metal:render:bundles',
			taskPrefix + 'metal:render:html',
			cb
		);
	});

	gulp.task(taskPrefix + 'metal:prep:base-layout', function() {
		return gulp
			.src(path.join(pathSrc, 'layouts/base.tpl'), {
				base: pathSrc
			})
			.pipe(baseInject(options))
			.pipe(gulp.dest(TEMP_DIR_SITE));
	});

	gulp.task(taskPrefix + 'metal:prep:page-components', function() {
		return gulp
			.src(path.join(pathSrc, 'pages/**/*.js'), {
				base: pathSrc
			})
			.pipe(gulp.dest(TEMP_DIR_SITE));
	});

	gulp.task(taskPrefix + 'metal:prep:pages', function() {
		const cwd = process.cwd();

		const componentTemplate = getTemplate('component');

		const markdownFilter = filter(path.join(pathSrc, 'pages/**/*.md'), {
			restore: true
		});

		const partials = _.map(
			globby.sync(
				path.join(TEMP_DIR_SITE, '+(components|layouts|partials)/**/*.soy')
			),
			function(filePath) {
				const jsFilePath =
					path.join(
						path.dirname(filePath),
						path.basename(filePath, path.extname(filePath))
					) + '.js';

				if (fs.existsSync(jsFilePath)) {
					filePath = jsFilePath;
				} else if (path.extname(filePath) === '.soy') {
					filePath += '.js';
				}

				return path.join(cwd, filePath).split(path.sep).join('/');
			}
		);

		return gulp
			.src(path.join(pathSrc, 'pages/**/*.+(html|md|soy)'), {
				base: pathSrc
			})
			.pipe(markdownFilter)
			.pipe(
				markdown({
					markdownOptions: options.markdownOptions,
					markdownRenderer: options.markdownRenderer
				})
			)
			.pipe(markdownFilter.restore)
			.pipe(layout())
			.pipe(frontMatter())
			.on('error', handleError)
			.pipe(
				data(function(file) {
					let filePath = file.path;
					const namespace = util.getNamespaceFromContents(file);

					const componentContents = componentTemplate({
						imports: metalComponents.concat(partials),
						name: namespace,
						soyName: path.basename(filePath)
					});

					filePath = path.relative(path.join(cwd, pathSrc), filePath);

					const componentPath = path.join(
						TEMP_DIR_SITE,
						path.dirname(filePath),
						path.basename(filePath, path.extname(filePath)) + '.js'
					);

					fs.outputFileSync(componentPath, componentContents);

					return file;
				})
			)
			.pipe(tokenReplace(options))
			.pipe(gulp.dest(TEMP_DIR_SITE));
	});

	gulp.task(taskPrefix + 'metal:prep:partials', function() {
		return gulp
			.src(path.join(pathSrc, '+(components|partials)/**/*.+(js|soy)'), {
				base: pathSrc
			})
			.pipe(gulp.dest(TEMP_DIR_SITE));
	});

	gulp.task(taskPrefix + 'metal:prep:layouts', function() {
		return gulp
			.src(
				[
					path.join(pathSrc, 'layouts/*.soy'),
					path.join('!' + pathSrc, 'layouts/base.soy')
				],
				{
					base: pathSrc
				}
			)
			.pipe(gulp.dest(TEMP_DIR_SITE));
	});

	gulp.task(taskPrefix + 'metal:prep:transpile', function() {
		return gulp.src(path.join(TEMP_DIR_SITE, '**/*.js'))
			.pipe(babel({
				presets: [require('babel-preset-env')]
			}))
			.pipe(gulp.dest(TEMP_DIR_SITE));
	});

	gulp.task(
		taskPrefix + 'metal:render:bundles',
		function() {
			return gulp
				.src([
					path.join(TEMP_DIR_SITE, '**/*.js'),
					'!' + path.join(TEMP_DIR_SITE, '**/*.soy.js')
				])
				.pipe(
					bundle({
						dest: pathDest,
						entryPoints: options.entryPoints,
						modules: options.resolveModules,
						uglify: options.uglifyBundle
					})
				);
		}
	);

	gulp.task(
		taskPrefix + 'metal:render:html',
		function() {
			const baseTemplate = _.template(fs.readFileSync(path.join(TEMP_DIR_SITE, 'layouts/base.tpl')));
			const siteData = util.getSiteData(pathDest);

			return gulp
				.src([
					path.join(TEMP_DIR_SITE, 'pages/**/*.js'),
					'!' + path.join(TEMP_DIR_SITE, '**/*.soy.js')
				], {
					read: false
				})
				.pipe(
					data(function(file) {
						const component = require(file.path);
						const data = getPageData(file, siteData);

						data.page.componentName = component.default.name;

						const content = Component.renderToString(component.default, {
							page: data.page,
							pageLocation: data.pageLocation,
							site: data.site
						});

						file.contents = new Buffer(
							baseTemplate({
								basePath: options.basePath,
								content: content,
								page: data.page,
								serialized: data.serialized,
								site: data.site
							})
						);

						file.path = file.path.replace(path.extname(file.path), '.html');

						return file;
					})
				)
				.pipe(gulp.dest(pathDest));
		}
	);

	gulp.task(taskPrefix + 'metal:render:soy', function() {
		let soyDeps = ['node_modules/+(metal)*/src/**/*.soy'];

		const metalSoyPaths = util.resolveMetalSoyPaths(options.metalComponents);

		if (metalSoyPaths.length) {
			soyDeps = metalSoyPaths;
		}

		return gulp
			.src(path.join(TEMP_DIR_SITE, '**/*.soy'))
			.pipe(
				compileSoy({
					outputDir: path.join(process.cwd(), TEMP_DIR_SOY),
					soyDeps: soyDeps
				}).on('error', handleError)
			)
			.pipe(gulp.dest(TEMP_DIR_SITE));
	});

	function getPageData(file, siteData) {
		siteData = _.cloneDeep(siteData);

		const url = util.getPageURL(file.path, path.join(TEMP_DIR_SITE, 'pages'));

		util.setActive(siteData.index, url);
		util.configureTopbar(siteData);

		const page = _.omit(util.getPageByURL(siteData.index, url), ['content']);

		const pageLocation = util.getTreeLocation(page.srcFilePath);

		return {
			page: page,
			pageLocation: pageLocation,
			serialized: JSON.stringify({
				pageLocation: pageLocation,
				site: siteData
			}),
			site: siteData
		};
	}
};
