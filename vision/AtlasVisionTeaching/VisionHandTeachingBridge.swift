import WebKit

/// Single-shot completion also handles a stalled/terminated WebContent process.
@MainActor private final class VisionHandReply {
    var continuation: CheckedContinuation<Any, Error>?
    var timeout: Task<Void, Never>?
    func finish(_ result: Result<Any, Error>) {
        guard let continuation else { return }
        self.continuation = nil; timeout?.cancel(); timeout = nil
        continuation.resume(with: result)
    }
}

extension VisionWorkbench {
    func handTeachingCall<Request: Encodable, Response: Decodable>(_ method: String, payload: Request,
                                                                  timeout: Double = 20) async throws -> Response {
        guard ready, let webView, ["start", "solve", "record"].contains(method) else { throw TeachingError("本机工程引擎尚未就绪") }
        let payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(payload))
        let value: Any = try await withCheckedThrowingContinuation { continuation in
            let reply = VisionHandReply(); reply.continuation = continuation
            reply.timeout = Task { @MainActor in
                do { try await Task.sleep(for: .seconds(timeout)) } catch { return }
                reply.finish(.failure(TeachingError("本机工程引擎响应超时")))
            }
            webView.callAsyncJavaScript("if (!window.AtlasVisionHands) throw new Error('请重新构建 Vision Pro 专用工作台'); return await window.AtlasVisionHands[method](payload);",
                arguments: ["method": method, "payload": payload], in: nil, in: .page) { result in
                    if case .failure(let error) = result,
                       let detail = (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String {
                        reply.finish(.failure(TeachingError(detail)))
                    } else { reply.finish(result) }
                }
        }
        return try JSONDecoder().decode(Response.self, from: JSONSerialization.data(withJSONObject: value))
    }
    func stopHandTeachingBridge() {
        webView?.evaluateJavaScript("window.AtlasVisionHands?.stop()", completionHandler: nil)
    }
}
