import { promises as fs } from "fs";

import puppeteer from "puppeteer";
import purifycss from "purify-css";
import terser from "terser";

import { startServer } from "./dev-server.mjs";
import { BUNDLE_NAME, PORT_NUMBER } from "./dev-config.mjs";
import generateJS from "./prod-build-js.mjs";

const OUTPUT_FILE = "index.html";

function extractUsefulHTML(bundleURL) {
  return import(bundleURL)
    .then(module => module.default)
    .then(() =>
      purifycss(
        document.documentElement.outerHTML,
        Array.from(document.head.querySelectorAll("style")).reduce(
          (pv, style) => {
            pv += style.textContent;
            style.remove();
            return pv;
          },
          ""
        )
      )
    )
    .then(css => {
      const style = document.createElement("style");
      style.textContent = css;
      document.head.append(style);
      Array.from(document.head.childNodes)
        .concat(Array.from(document.body.childNodes))
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .forEach(n => n.remove());

      Array.from(document.querySelectorAll("svg.svg-inline--fa")).forEach(
        ({ classList }) => {
          let className,
            item = 0;
          while ((className = classList.item(item))) {
            if (className.endsWith("-undefined")) {
              classList.remove(className);
            } else {
              item++;
            }
          }
        }
      );
      return document.documentElement.outerHTML;
    });
}

const getGeneratedFileSize = () =>
  fs.stat(OUTPUT_FILE).then(stats => stats.size);

const generateBundledHTML = async browser => {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT_NUMBER}/originalIndexFile`);

  await page.evaluate(env => (window.process = { env }), process.env);
  await page.exposeFunction("purifycss", (html, css) =>
    purifycss(html, css, {
      minify: true,
      info: true,
      rejected: false,
    }).replace(/\n/g, "")
  );

  const html = await page.evaluate(extractUsefulHTML, `/${BUNDLE_NAME}`);

  await browser.close();

  return generateJS()
    .then(
      chunks =>
        "(function(){var n={};define=function(i,o,c){c.apply(this,o.map(function() {return n}))}})();" +
        chunks.output.map(({ code }) => code).join(";")
    )
    .then(jsCode => terser.minify(jsCode, { toplevel: true }))
    .then(result => (result.error ? Promise.reject(error) : result.code))
    .then(
      jsCode =>
        "<!DOCTYPE html>\n" +
        html.replace(
          "</body></html>",
          `<script>${jsCode}</script></body></html>`
        )
    );
};

Promise.all([getGeneratedFileSize(), startServer()])
  .then(([previousFileSize]) =>
    puppeteer
      .launch()
      .then(generateBundledHTML)
      .then(html => fs.writeFile(OUTPUT_FILE, html))
      .then(getGeneratedFileSize)
      .then(
        newFileSize =>
          `New file is ${newFileSize - previousFileSize} bytes bigger.`
      )
  )
  .then(console.log)
  .catch(console.error)
  .finally(() => process.exit());
