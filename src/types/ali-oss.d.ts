/**
 * ali-oss 6.23.x 的最小类型声明。
 *
 * 安装的 ali-oss@6.23.0 自带 package.json 里没有 types 字段，也没有 @types/ali-oss，
 * 所以这里只声明本项目真正用到的低层 API。字段与 6.23.0
 * `dist/aliyun-oss-sdk.js` 中的实现一一对应，不做臆测：
 *
 *   initMultipartUpload(name, options)                 -> { res, bucket, name, uploadId }
 *   uploadPart(name, uploadId, partNo, file, s, e, opt) -> { name, etag, res }   // etag 来自 res.headers.etag
 *   completeMultipartUpload(name, uploadId, parts, opt) -> { res, ... }
 *   abortMultipartUpload(name, uploadId, options)
 *   put(name, file, options)
 */
declare module 'ali-oss' {
  export interface OSSOptions {
    region: string
    bucket: string
    accessKeyId: string
    accessKeySecret: string
    /** STS 临时凭证，不是长期 AccessKey。 */
    stsToken: string
    secure?: boolean
    timeout?: number
    endpoint?: string
    cname?: boolean
    [key: string]: unknown
  }

  export interface OSSResponseMeta {
    status: number
    headers: Record<string, string>
  }

  export interface InitMultipartUploadResult {
    res: OSSResponseMeta
    bucket: string
    name: string
    uploadId: string
  }

  export interface UploadPartResult {
    name: string
    /** OSS 返回的分片 ETag（来自响应头 etag）。 */
    etag: string
    res: OSSResponseMeta
  }

  export interface CompleteMultipartUploadResult {
    res: OSSResponseMeta
    name?: string
    data?: unknown
  }

  export interface PutObjectResult {
    name: string
    url: string
    res: OSSResponseMeta
  }

  export interface MultipartPart {
    number: number
    etag: string
  }

  export default class OSS {
    constructor(options: OSSOptions)

    put(
      name: string,
      file: Blob,
      options?: Record<string, unknown>
    ): Promise<PutObjectResult>

    initMultipartUpload(
      name: string,
      options?: Record<string, unknown>
    ): Promise<InitMultipartUploadResult>

    /**
     * 浏览器环境下 file 必须是 Blob/File：SDK 内部会 `file.slice(start, end)`。
     * 对单个分片 Blob 使用 start = 0、end = blob.size。
     */
    uploadPart(
      name: string,
      uploadId: string,
      partNo: number,
      file: Blob,
      start: number,
      end: number,
      options?: Record<string, unknown>
    ): Promise<UploadPartResult>

    completeMultipartUpload(
      name: string,
      uploadId: string,
      parts: MultipartPart[],
      options?: Record<string, unknown>
    ): Promise<CompleteMultipartUploadResult>

    abortMultipartUpload(
      name: string,
      uploadId: string,
      options?: Record<string, unknown>
    ): Promise<unknown>
  }
}
