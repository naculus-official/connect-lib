/// <reference types="vitest" />

import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger, setLogLevel, setLogSink } from "./logger";

describe("logger", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Reset log level to warn for each test
    setLogLevel("warn");
    setLogSink(null);
  });

  it("should log warn messages by default", () => {
    logger.warn("test", "hello");
    expect(console.warn).toHaveBeenCalledWith("[test]", "hello");
  });

  it("should log error messages by default", () => {
    logger.error("test", "oops");
    expect(console.error).toHaveBeenCalledWith("[test]", "oops");
  });

  it("should suppress debug messages at default level (warn)", () => {
    logger.debug("test", "secret");
    expect(console.debug).not.toHaveBeenCalled();
  });

  it("should suppress info messages at default level (warn)", () => {
    logger.info("test", "noise");
    expect(console.info).not.toHaveBeenCalled();
  });

  it("should allow debug messages when level is debug", () => {
    setLogLevel("debug");
    logger.debug("test", "verbose");
    expect(console.debug).toHaveBeenCalledWith("[test]", "verbose");
  });

  it("should allow info messages when level is info", () => {
    setLogLevel("info");
    logger.info("test", "ok");
    expect(console.info).toHaveBeenCalledWith("[test]", "ok");
  });

  it("should suppress everything at silent level", () => {
    setLogLevel("silent");
    logger.warn("test", "quiet");
    logger.error("test", "hidden");
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("should call custom sink when provided", () => {
    const sink = vi.fn();
    setLogSink(sink);
    logger.warn("my-ns", "via sink", 42);
    expect(sink).toHaveBeenCalledWith("warn", "my-ns", "via sink", 42);
  });

  it("should not call console when custom sink is provided", () => {
    setLogSink(vi.fn());
    logger.warn("ns", "msg");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("should reset to console fallback after sink is cleared", () => {
    setLogSink(vi.fn());
    setLogSink(null);
    logger.warn("ns", "back to console");
    expect(console.warn).toHaveBeenCalledWith("[ns]", "back to console");
  });

  it("should provide namespaced convenience via for()", () => {
    const ns = logger.for("my-module");
    ns.warn("something is off");
    expect(console.warn).toHaveBeenCalledWith(
      "[my-module]",
      "something is off",
    );
  });

  it("should return current log level", () => {
    expect(logger.getLogLevel()).toBe("warn");
    setLogLevel("silent");
    expect(logger.getLogLevel()).toBe("silent");
  });

  it("should pass multiple arguments to console", () => {
    const err = new Error("test");
    logger.error("ns", "failed:", err);
    expect(console.error).toHaveBeenCalledWith("[ns]", "failed:", err);
  });

  it("should pass multiple arguments to custom sink", () => {
    const sink = vi.fn();
    setLogSink(sink);
    const err = new Error("custom");
    logger.warn("ns", "something:", err);
    expect(sink).toHaveBeenCalledWith("warn", "ns", "something:", err);
  });
});
