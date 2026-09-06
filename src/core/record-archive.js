// Private immutable JSON records shared by scrape and submission archives.
import { mkdir, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function writeArchiveRecord(directory, record) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${Date.now()}-${randomUUID()}.json`);
    const temporary = `${file}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
        await handle.writeFile(JSON.stringify(record));
        await handle.sync();
    } finally {
        await handle.close();
    }
    await rename(temporary, file);
    // Windows cannot open directories for fsync. File sync + rename still
    // gives atomic readers; supported platforms also persist the directory.
    let directoryHandle;
    try {
        directoryHandle = await open(directory, 'r');
        await directoryHandle.sync();
    } catch (error) {
        if (process.platform !== 'win32') throw error;
    } finally {
        await directoryHandle?.close();
    }
    return file;
}
