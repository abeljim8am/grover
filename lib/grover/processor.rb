# frozen_string_literal: true

require_relative 'processor_base'

class Grover
  #
  # Processor helper class for calling out to Puppeteer NodeJS library
  #
  # Heavily based on the Schmooze library https://github.com/Shopify/schmooze
  #
  class Processor
    include ProcessorBase

    def initialize(app_root)
      @app_root = app_root
    end

    def convert(method, url_or_html, options)
      spawn_process
      ensure_packages_are_initiated
      result = call_js_method method, url_or_html, options
      process_result(result)
    ensure
      cleanup_process if stdin
    end
  end
end
