/**
 * @license
 * Copyright 2019 The Bazel Authors. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Stats } from 'fs'
import * as path from 'path'
import * as util from 'util'

// windows cant find the right types
type Dir = any
type Dirent = any

// using require here on purpose so we can override methods with any
// also even though imports are mutable in typescript the cognitive dissonance is too high because
// es modules
const _fs = require('fs')

const HOP_NON_LINK = Symbol.for('HOP NON LINK')

export const patcher = (fs: any = _fs, roots: string[]) => {
    fs = fs || _fs
    // Make the original version of the library available for when access to the
    // unguarded file system is necessary, such as the esbuild plugin that
    // protects against sandbox escaping that occurs through module resolution
    // in the Go binary. See
    // https://github.com/aspect-build/rules_esbuild/issues/58.
    fs._unpatched = { ...fs }
    roots = roots || []
    roots = roots.filter((root) => fs.existsSync(root))
    if (!roots.length) {
        if (process.env.VERBOSE_LOGS) {
            console.error(
                'fs patcher called without any valid root paths ' + __filename
            )
        }
        return
    }

    const origLstat = fs.lstat.bind(fs)
    const origLstatSync = fs.lstatSync.bind(fs)

    const origReaddir = fs.readdir.bind(fs)
    const origReaddirSync = fs.readdirSync.bind(fs)

    const origReadlink = fs.readlink.bind(fs)
    const origReadlinkSync = fs.readlinkSync.bind(fs)

    const origRealpath = fs.realpath.bind(fs)
    const origRealpathNative = fs.realpath.native
    const origRealpathSync = fs.realpathSync.bind(fs)
    const origRealpathSyncNative = fs.realpathSync.native

    const isEscape = escapeFunction(roots)

    // =========================================================================
    // fs.lstat
    // =========================================================================

    fs.lstat = (...args: any[]) => {
        let cb = args.length > 1 ? args[args.length - 1] : undefined

        // preserve error when calling function without required callback
        if (!cb) {
            return origLstat(...args)
        }

        cb = once(cb)

        // override the callback
        args[args.length - 1] = (err: Error, stats: Stats) => {
            if (err) return cb(err)

            if (!stats.isSymbolicLink()) {
                // the file is not a symbolic link so there is nothing more to do
                return cb(null, stats)
            }

            args[0] = path.resolve(args[0])
            return guardedReadLink(args[0], (str: string) => {
                if (str != args[0]) {
                    // there are one or more hops within the guards so there is nothing more to do
                    return cb(null, stats)
                }

                // there are no hops so lets report the stats of the real file;
                // we can't use origRealPath here since that function calls lstat internally
                // which can result in an infinite loop
                return unguardedRealPath(args[0], (err: Error, str: string) => {
                    if (err) {
                        if ((err as any).code === 'ENOENT') {
                            // broken link so there is nothing more to do
                            return cb(null, stats)
                        }
                        return cb(err)
                    }
                    return origLstat(str, (err, str) => cb(err, str))
                })
            })
        }

        origLstat(...args)
    }

    fs.lstatSync = function lstatSync(...args: any[]) {
        const stats = origLstatSync(...args)

        if (!stats.isSymbolicLink()) {
            // the file is not a symbolic link so there is nothing more to do
            return stats
        }

        args[0] = path.resolve(args[0])
        const guardedReadLink: string = guardedReadLinkSync(args[0])
        if (guardedReadLink != args[0]) {
            // there are one or more hops within the guards so there is nothing more to do
            return stats
        }

        try {
            // there are no hops so lets report the stats of the real file;
            // we can't use origRealPathSync here since that function calls lstat internally
            // which can result in an infinite loop
            return origLstatSync(
                unguardedRealPathSync(args[0]),
                ...args.slice(1)
            )
        } catch (err) {
            if (err.code === 'ENOENT') {
                // broken link so there is nothing more to do
                return stats
            }
            throw err
        }
    }

    // =========================================================================
    // fs.realpath
    // =========================================================================

    fs.realpath = (...args: any[]) => {
        let cb = args.length > 1 ? args[args.length - 1] : undefined

        // preserve error when calling function without required callback
        if (!cb) {
            return origRealpath(...args)
        }

        cb = once(cb)

        args[args.length - 1] = (err: Error, str: string) => {
            if (err) return cb(err)
            const escapedRoot: string | false = isEscape(args[0], str)
            if (escapedRoot) {
                return guardedRealPath(
                    args[0],
                    (err, str) => cb(err, str),
                    escapedRoot
                )
            } else {
                return cb(null, str)
            }
        }

        origRealpath(...args)
    }

    fs.realpath.native = (...args: any[]) => {
        let cb = args.length > 1 ? args[args.length - 1] : undefined

        // preserve error when calling function without required callback
        if (!cb) {
            return origRealpathNative(...args)
        }

        cb = once(cb)

        args[args.length - 1] = (err: Error, str: string) => {
            if (err) return cb(err)
            const escapedRoot: string | false = isEscape(args[0], str)
            if (escapedRoot) {
                return guardedRealPath(
                    args[0],
                    (err, str) => cb(err, str),
                    escapedRoot
                )
            } else {
                return cb(null, str)
            }
        }

        origRealpathNative(...args)
    }

    fs.realpathSync = function realpathSync(...args: any[]) {
        const str = origRealpathSync(...args)
        const escapedRoot: string | false = isEscape(args[0], str)
        if (escapedRoot) {
            return guardedRealPathSync(args[0], escapedRoot)
        }
        return str
    }

    fs.realpathSync.native = function native_realpathSync(...args: any[]) {
        const str = origRealpathSyncNative(...args)
        const escapedRoot: string | false = isEscape(args[0], str)
        if (escapedRoot) {
            return guardedRealPathSync(args[0], escapedRoot)
        }
        return str
    }

    // =========================================================================
    // fs.readlink
    // =========================================================================

    fs.readlink = (...args: any[]) => {
        let cb = args.length > 1 ? args[args.length - 1] : undefined

        // preserve error when calling function without required callback
        if (!cb) {
            return origReadlink(...args)
        }

        cb = once(cb)
        args[args.length - 1] = (err: Error, str: string) => {
            if (err) return cb(err)
            const resolved = path.resolve(args[0])
            str = path.resolve(path.dirname(resolved), str)
            const escapedRoot: string | false = isEscape(resolved, str)
            if (escapedRoot) {
                return nextHop(str, (next: string | false) => {
                    if (!next) {
                        if (next == undefined) {
                            // The escape from the root is not mappable back into the root; throw EINVAL
                            return cb(enoent('readlink', args[0]))
                        } else {
                            // The escape from the root is not mappable back into the root; throw EINVAL
                            return cb(einval('readlink', args[0]))
                        }
                    }
                    next = path.resolve(
                        path.dirname(resolved),
                        path.relative(path.dirname(str), next)
                    )
                    if (
                        next != resolved &&
                        !isEscape(resolved, next, [escapedRoot])
                    ) {
                        return cb(null, next)
                    }
                    // The escape from the root is not mappable back into the root; we must make
                    // this look like a real file so we call readlink on the realpath which we
                    // expect to return an error
                    return origRealpath(resolved, (err, str) => {
                        if (err) return cb(err)
                        return origReadlink(str, (err, str) => cb(err, str))
                    })
                })
            } else {
                return cb(null, str)
            }
        }

        origReadlink(...args)
    }

    fs.readlinkSync = function readlinkSync(...args: any[]) {
        const resolved = path.resolve(args[0])

        const str = path.resolve(
            path.dirname(resolved),
            origReadlinkSync(...args)
        )

        const escapedRoot: string | false = isEscape(resolved, str)
        if (escapedRoot) {
            let next: string | false = nextHopSync(str)
            if (!next) {
                if (next == undefined) {
                    // The escape from the root is not mappable back into the root; throw EINVAL
                    throw enoent('readlink', args[0])
                } else {
                    // The escape from the root is not mappable back into the root; throw EINVAL
                    throw einval('readlink', args[0])
                }
            }
            next = path.resolve(
                path.dirname(resolved),
                path.relative(path.dirname(str), next)
            )
            if (next != resolved && !isEscape(resolved, next, [escapedRoot])) {
                return next
            }
            // The escape from the root is not mappable back into the root; throw EINVAL
            throw einval('readlink', args[0])
        }
        return str
    }

    // =========================================================================
    // fs.readdir
    // =========================================================================

    fs.readdir = (...args: any[]) => {
        const p = path.resolve(args[0])

        let cb = args[args.length - 1]
        if (typeof cb !== 'function') {
            // this will likely throw callback required error.
            return origReaddir(...args)
        }

        cb = once(cb)

        args[args.length - 1] = (err: Error, result: Dirent[]) => {
            if (err) return cb(err)
            // user requested withFileTypes
            if (result[0] && result[0].isSymbolicLink) {
                Promise.all(result.map((v: Dirent) => handleDirent(p, v)))
                    .then(() => {
                        cb(null, result)
                    })
                    .catch((err) => {
                        cb(err)
                    })
            } else {
                // string array return for readdir.
                cb(null, result)
            }
        }

        origReaddir(...args)
    }

    fs.readdirSync = function readdirSync(...args: any[]) {
        const res = origReaddirSync(...args)
        const p = path.resolve(args[0])
        res.forEach((v: Dirent | any) => {
            handleDirentSync(p, v)
        })
        return res
    }

    // =========================================================================
    // fs.opendir
    // =========================================================================

    if (fs.opendir) {
        const origOpendir = fs.opendir.bind(fs)
        fs.opendir = (...args: any[]) => {
            let cb = args[args.length - 1]
            // if this is not a function opendir should throw an error.
            // we call it so we don't have to throw a mock
            if (typeof cb === 'function') {
                cb = once(cb)
                args[args.length - 1] = async (err: Error, dir: Dir) => {
                    try {
                        cb(null, await handleDir(dir))
                    } catch (err) {
                        cb(err)
                    }
                }
                origOpendir(...args)
            } else {
                return origOpendir(...args).then((dir: Dir) => {
                    return handleDir(dir)
                })
            }
        }
    }

    // =========================================================================
    // fs.promises
    // =========================================================================

    /**
     * patch fs.promises here.
     *
     * this requires a light touch because if we trigger the getter on older nodejs versions
     * it will log an experimental warning to stderr
     *
     * `(node:62945) ExperimentalWarning: The fs.promises API is experimental`
     *
     * this api is available as experimental without a flag so users can access it at any time.
     */
    const promisePropertyDescriptor = Object.getOwnPropertyDescriptor(
        fs,
        'promises'
    )
    if (promisePropertyDescriptor) {
        const promises: any = {}
        promises.lstat = util.promisify(fs.lstat)
        // NOTE: node core uses the newer realpath function fs.promises.native instead of fs.realPath
        promises.realpath = util.promisify(fs.realpath.native)
        promises.readlink = util.promisify(fs.readlink)
        promises.readdir = util.promisify(fs.readdir)
        if (fs.opendir) promises.opendir = util.promisify(fs.opendir)
        // handle experimental api warnings.
        // only applies to version of node where promises is a getter property.
        if (promisePropertyDescriptor.get) {
            const oldGetter = promisePropertyDescriptor.get.bind(fs)
            const cachedPromises = {}

            promisePropertyDescriptor.get = () => {
                const _promises = oldGetter()
                Object.assign(cachedPromises, _promises, promises)
                return cachedPromises
            }
            Object.defineProperty(fs, 'promises', promisePropertyDescriptor)
        } else {
            // api can be patched directly
            Object.assign(fs.promises, promises)
        }
    }

    // =========================================================================
    // helper functions for dirs
    // =========================================================================

    async function handleDir(dir: Dir) {
        const p = path.resolve(dir.path)
        const origIterator = dir[Symbol.asyncIterator].bind(dir)
        const origRead: any = dir.read.bind(dir)

        dir[Symbol.asyncIterator] = async function* () {
            for await (const entry of origIterator()) {
                await handleDirent(p, entry)
                yield entry
            }
        }
        ;(dir.read as any) = async (...args: any[]) => {
            if (typeof args[args.length - 1] === 'function') {
                const cb = args[args.length - 1]
                args[args.length - 1] = async (err: Error, entry: Dirent) => {
                    cb(err, entry ? await handleDirent(p, entry) : null)
                }
                origRead(...args)
            } else {
                const entry = await origRead(...args)
                if (entry) {
                    await handleDirent(p, entry)
                }
                return entry
            }
        }
        const origReadSync: any = dir.readSync.bind(dir)
        ;(dir.readSync as any) = () => {
            return handleDirentSync(p, origReadSync()) // intentionally sync for simplicity
        }

        return dir
    }

    function handleDirent(p: string, v: Dirent): Promise<Dirent> {
        return new Promise((resolve, reject) => {
            if (!v.isSymbolicLink()) {
                return resolve(v)
            }
            const f = path.resolve(p, v.name)
            return guardedReadLink(f, (str: string) => {
                if (f != str) {
                    return resolve(v)
                }
                // There are no hops so we should hide the fact that the file is a symlink
                v.isSymbolicLink = () => false
                origRealpath(f, (err, str) => {
                    if (err) {
                        throw err
                    }
                    fs.stat(str, (err, stat) => {
                        if (err) {
                            throw err
                        }
                        patchDirent(v, stat)
                        resolve(v)
                    })
                })
            })
        })
    }

    function handleDirentSync(p: string, v: Dirent | null): void {
        if (v && v.isSymbolicLink) {
            if (v.isSymbolicLink()) {
                const f = path.resolve(p, v.name)
                if (f == guardedReadLinkSync(f)) {
                    // There are no hops so we should hide the fact that the file is a symlink
                    v.isSymbolicLink = () => false
                    const stat = fs.statSync(origRealpathSync(f))
                    patchDirent(v, stat)
                }
            }
        }
    }

    function nextHop(loc: string, cb: (next: string | false) => void): void {
        let maybe = loc
        let escapedHop: string | false = false
        let nested: string[] = []

        readHopLink(maybe, function readNextHop(link) {
            if (link === undefined) {
                return cb(undefined)
            }

            if (link === HOP_NON_LINK) {
                return cb(escapedHop)
            }

            link = path.join(link, ...nested.reverse())
            if (!isEscape(loc, link)) {
                return cb(link)
            }

            if (!escapedHop) {
                escapedHop = link
            }

            nested.push(path.basename(maybe))
            const dirname = path.dirname(maybe)
            if (
                !dirname ||
                dirname == maybe ||
                dirname == '.' ||
                dirname == '/'
            ) {
                // not a link
                return cb(escapedHop)
            }
            maybe = dirname
            readHopLink(maybe, readNextHop)
        })
    }

    const hopLinkCache = new Map<string, string | typeof HOP_NON_LINK>()
    function readHopLinkSync(p: string) {
        if (hopLinkCache.has(p)) {
            return hopLinkCache.get(p)
        }

        let link: string | typeof HOP_NON_LINK

        try {
            if (origLstatSync(p).isSymbolicLink()) {
                link = origReadlinkSync(p) as string
                if (!path.isAbsolute(link)) {
                    link = path.resolve(path.dirname(p), link)
                }
            } else {
                link = HOP_NON_LINK
            }
        } catch (err) {
            if (err.code === 'ENOENT') {
                // file does not exist
                return undefined
            }

            link = HOP_NON_LINK
        }

        hopLinkCache.set(p, link)
        return link
    }

    function readHopLink(
        p: string,
        cb: (l: string | typeof HOP_NON_LINK) => void
    ) {
        origReadlink(p, (err: Error, link: string) => {
            if (err) {
                if ((err as any).code === 'ENOENT') {
                    // file does not exist
                    return cb(undefined)
                }

                return cb(HOP_NON_LINK)
            }

            if (link === undefined) {
                return cb(HOP_NON_LINK)
            }

            if (!path.isAbsolute(link)) {
                link = path.resolve(path.dirname(p), link)
            }

            cb(link)
        })
    }

    function nextHopSync(loc: string): string | false {
        let nested: string[] = []
        let maybe = loc
        let escapedHop: string | false = false

        for (;;) {
            let link = readHopLinkSync(maybe)

            if (link === undefined) {
                return escapedHop
            }

            if (link !== HOP_NON_LINK) {
                link = path.join(link, ...nested.reverse())

                if (!isEscape(loc, link)) {
                    return link
                }
                if (!escapedHop) {
                    escapedHop = link
                }
            }

            const dirname = path.dirname(maybe)
            if (
                !dirname ||
                dirname == maybe ||
                dirname == '.' ||
                dirname == '/'
            ) {
                // not a link
                return escapedHop
            }

            nested.push(path.basename(maybe))
            maybe = dirname
        }
    }

    function guardedReadLink(start: string, cb: (str: string) => void): void {
        let loc = start
        return nextHop(loc, (next: string | false) => {
            if (!next) {
                // we're no longer hopping but we haven't escaped;
                // something funky happened in the filesystem
                return cb(loc)
            }
            if (isEscape(loc, next)) {
                // this hop takes us out of the guard
                return cb(loc)
            }
            return cb(next)
        })
    }

    function guardedReadLinkSync(start: string): string {
        let loc = start
        let next: string | false = nextHopSync(loc)
        if (!next) {
            // we're no longer hopping but we haven't escaped;
            // something funky happened in the filesystem
            return loc
        }
        if (isEscape(loc, next)) {
            // this hop takes us out of the guard
            return loc
        }
        return next
    }

    function unguardedRealPath(
        start: string,
        cb: (err: Error, str?: string) => void
    ): void {
        start = String(start) // handle the "undefined" case (matches behavior as fs.realpath)
        const oneHop = (loc, cb) => {
            nextHop(loc, (next) => {
                if (next == undefined) {
                    // file does not exist (broken link)
                    return cb(enoent('realpath', start))
                } else if (!next) {
                    // we've hit a real file
                    return cb(null, loc)
                }
                oneHop(next, cb)
            })
        }
        oneHop(start, cb)
    }

    function guardedRealPath(
        start: string,
        cb: (err: Error, str?: string) => void,
        escapedRoot: string = undefined
    ): void {
        start = String(start) // handle the "undefined" case (matches behavior as fs.realpath)
        const oneHop = (
            loc: string,
            cb: (err: Error, str?: string) => void
        ) => {
            nextHop(loc, (next) => {
                if (!next) {
                    // we're no longer hopping but we haven't escaped
                    return fs.exists(loc, (e) => {
                        if (e) {
                            // we hit a real file within the guard and can go no further
                            return cb(null, loc)
                        } else {
                            // something funky happened in the filesystem
                            return cb(enoent('realpath', start))
                        }
                    })
                }
                if (
                    escapedRoot
                        ? isEscape(loc, next, [escapedRoot])
                        : isEscape(loc, next)
                ) {
                    // this hop takes us out of the guard
                    return cb(null, loc)
                }
                oneHop(next, cb)
            })
        }
        oneHop(start, cb)
    }

    function unguardedRealPathSync(start: string): string {
        start = String(start) // handle the "undefined" case (matches behavior as fs.realpathSync)
        for (let loc = start, next; ; loc = next) {
            next = nextHopSync(loc)
            if (next == undefined) {
                // file does not exist (broken link)
                throw enoent('realpath', start)
            } else if (!next) {
                // we've hit a real file
                return loc
            }
        }
    }

    function guardedRealPathSync(
        start: string,
        escapedRoot: string = undefined
    ): string {
        start = String(start) // handle the "undefined" case (matches behavior as fs.realpathSync)
        for (let loc = start, next: string | false; ; loc = next as string) {
            next = nextHopSync(loc)
            if (!next) {
                // we're no longer hopping but we haven't escaped
                if (fs.existsSync(loc)) {
                    // we hit a real file within the guard and can go no further
                    return loc
                } else {
                    // something funky happened in the filesystem; throw ENOENT
                    throw enoent('realpath', start)
                }
            }
            if (
                escapedRoot
                    ? isEscape(loc, next, [escapedRoot])
                    : isEscape(loc, next)
            ) {
                // this hop takes us out of the guard
                return loc
            }
        }
    }
}

// =========================================================================
// generic helper functions
// =========================================================================

export function isSubPath(parent: string, child: string): boolean {
    return (
        parent === child ||
        (child[parent.length] === path.sep && child.startsWith(parent))
    )
}

export function escapeFunction(_roots: string[]) {
    // Ensure roots are always absolute.
    // Sort to ensure escaping multiple roots chooses the longest one.
    const defaultRoots = _roots
        .map((root) => path.resolve(root))
        .sort((a, b) => b.length - a.length)

    return function fs_isEscape(
        linkPath: string,
        linkTarget: string,
        roots = defaultRoots
    ): false | string {
        // linkPath is the path of the symlink file itself
        // linkTarget is a path that the symlink points to one or more hops away

        if (!path.isAbsolute(linkPath)) {
            linkPath = path.resolve(linkPath)
        }

        if (!path.isAbsolute(linkTarget)) {
            linkTarget = path.resolve(linkTarget)
        }

        for (const root of roots) {
            // If the link is in the root check if the realPath has escaped
            if (isSubPath(root, linkPath) && !isSubPath(root, linkTarget)) {
                return root
            }
        }

        return false
    }
}

function once<T>(fn: (...args: unknown[]) => T) {
    let called = false

    return (...args: unknown[]) => {
        if (called) return
        called = true

        let err: Error | false = false
        try {
            fn(...args)
        } catch (_e) {
            err = _e
        }

        // blow the stack to make sure this doesn't fall into any unresolved promise contexts
        if (err) {
            setImmediate(() => {
                throw err
            })
        }
    }
}

function patchDirent(dirent: Dirent | any, stat: Stats | any): void {
    // add all stat is methods to Dirent instances with their result.
    for (const i in stat) {
        if (i.indexOf('is') === 0 && typeof stat[i] === 'function') {
            //
            const result = stat[i]()
            if (result) dirent[i] = () => true
            else dirent[i] = () => false
        }
    }
}

function enoent(s: string, p: string): Error {
    let err = new Error(`ENOENT: no such file or directory, ${s} '${p}'`)
    ;(err as any).errno = -2
    ;(err as any).syscall = s
    ;(err as any).code = 'ENOENT'
    ;(err as any).path = p
    return err
}

function einval(s: string, p: string): Error {
    let err = new Error(`EINVAL: invalid argument, ${s} '${p}'`)
    ;(err as any).errno = -22
    ;(err as any).syscall = s
    ;(err as any).code = 'EINVAL'
    ;(err as any).path = p
    return err
}
