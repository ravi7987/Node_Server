// console.time('writemany')
// let a = 3 + 3;
// console.timeEnd('writemany')

// const fs = require("node:fs/promises");

// (async () => {
//     console.time('write');
//     const filehandle = await fs.open('test.txt', 'w');
//     for (let i = 0; i < 1000000; i++) {
//         await filehandle.write(` ${i} `);
//     }
//     console.timeEnd('write');
// })()

const fs = require('node:fs');

(async () => {
    console.time('write');
    fs.open('test.txt', "w", (err, fd) => {
        for (let i = 0; i < 1000000; i++) {
            fs.writeSync(fd, ` ${i} `);
        }
    })
    console.timeEnd('write')
})()