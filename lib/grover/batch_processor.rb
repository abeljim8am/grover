# frozen_string_literal: true

require_relative 'processor_base'

class Grover
  #
  # BatchProcessor for efficient batch PDF generation with persistent browser connection
  #
  # Keeps the Node.js process and browser connection alive across multiple PDF generations,
  # significantly improving performance for batch operations.
  #
  class BatchProcessor
    include ProcessorBase

    def initialize(app_root = Dir.pwd)
      @app_root = app_root
      @started = false
      @streaming = false
      @mutex = Mutex.new
    end

    def convert(method, url_or_html, options = {})
      @mutex.synchronize do
        ensure_process_running
        result = call_js_method 'batch', method, url_or_html, options_with_retry(options)
        process_result(result)
      end
    end

    def stream_start(options = {})
      @mutex.synchronize do
        raise Grover::Error, 'Streaming session already active' if @streaming

        ensure_process_running
        call_js_method 'streamStart', options_with_retry(options)
        @streaming = true
      end
    end

    def stream_append(html_chunk)
      @mutex.synchronize do
        raise Grover::Error, 'No active streaming session' unless @streaming

        ensure_process_running
        call_js_method 'streamAppend', html_chunk
      end
    end

    def stream_finish
      @mutex.synchronize do
        raise Grover::Error, 'No active streaming session' unless @streaming

        ensure_process_running
        result = call_js_method 'streamFinish'
        @streaming = false
        process_result(result)
      end
    end

    def shutdown
      @mutex.synchronize do
        return unless @started

        begin
          call_js_method 'shutdown'
        rescue StandardError; end
        cleanup_process
        @started = false
        @streaming = false
      end
    end

    def alive?
      @mutex.synchronize do
        return false unless @started && stdin && !stdin.closed?

        begin
          result = call_js_method 'ping'
          result.is_a?(Hash) && result['alive']
        rescue StandardError
          false
        end
      end
    end

    def self.batch(app_root = Dir.pwd)
      processor = new(app_root)
      yield processor
    ensure
      processor&.shutdown
    end

    private

    def ensure_process_running
      return if @started && stdin && !stdin.closed?

      spawn_process
      ensure_packages_are_initiated
      @started = true
    end

    def options_with_retry(options)
      options.merge(
        'retryCount' => Grover.configuration.batch_retry_count,
        'retryDelay' => Grover.configuration.batch_retry_delay
      )
    end
  end
end
