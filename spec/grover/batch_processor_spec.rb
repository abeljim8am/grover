# frozen_string_literal: true

require 'spec_helper'

describe Grover::BatchProcessor do
  subject(:processor) { described_class.new Dir.pwd }

  after { processor.shutdown }

  describe '#convert' do
    subject(:convert) { processor.convert method, url_or_html, options }

    let(:method) { :pdf }
    let(:options) { {} }

    context 'when converting HTML to PDF' do
      let(:url_or_html) { '<html><body><h1>Hello Batch</h1></body></html>' }

      let(:pdf_reader) { PDF::Reader.new pdf_io }
      let(:pdf_io) { StringIO.new convert }
      let(:pdf_text_content) { Grover::Utils.squish(pdf_reader.pages.first.text) }

      it { is_expected.to start_with "%PDF-1.4\n" }
      it { expect(pdf_reader.page_count).to eq 1 }
      it { expect(pdf_text_content).to eq 'Hello Batch' }
    end

    context 'when converting a URL to PDF' do
      let(:url_or_html) { 'http://localhost:4567' }

      let(:pdf_reader) { PDF::Reader.new pdf_io }
      let(:pdf_io) { StringIO.new convert }
      let(:pdf_text_content) { Grover::Utils.squish(pdf_reader.pages.first.text) }

      it { is_expected.to start_with "%PDF-1.4\n" }
      it { expect(pdf_reader.page_count).to eq 1 }
      it { expect(pdf_text_content).to include "I'm Feeling Grovery" }
    end
  end

  describe 'batch processing multiple PDFs' do
    let(:first_doc_html) { '<html><body><h1>Document 1</h1></body></html>' }
    let(:second_doc_html) { '<html><body><h1>Document 2</h1></body></html>' }
    let(:third_doc_html) { '<html><body><h1>Document 3</h1></body></html>' }

    it 'generates multiple PDFs in sequence' do
      pdf1 = processor.convert(:pdf, first_doc_html, {})
      pdf2 = processor.convert(:pdf, second_doc_html, {})
      pdf3 = processor.convert(:pdf, third_doc_html, {})

      expect(pdf1).to start_with "%PDF-1.4\n"
      expect(pdf2).to start_with "%PDF-1.4\n"
      expect(pdf3).to start_with "%PDF-1.4\n"

      expect(PDF::Reader.new(StringIO.new(pdf1)).pages.first.text).to include 'Document 1'
      expect(PDF::Reader.new(StringIO.new(pdf2)).pages.first.text).to include 'Document 2'
      expect(PDF::Reader.new(StringIO.new(pdf3)).pages.first.text).to include 'Document 3'
    end

    it 'keeps the process alive between conversions' do
      processor.convert(:pdf, first_doc_html, {})

      expect(processor.alive?).to be true

      processor.convert(:pdf, second_doc_html, {})

      expect(processor.alive?).to be true
    end
  end

  describe '#stream_start, #stream_append, #stream_finish' do
    it 'generates PDF from streamed HTML chunks' do
      processor.stream_start({})
      processor.stream_append('<html><body>')
      processor.stream_append('<h1>Streamed ')
      processor.stream_append('Content</h1>')
      processor.stream_append('</body></html>')
      pdf = processor.stream_finish

      expect(pdf).to start_with "%PDF-1.4\n"

      pdf_reader = PDF::Reader.new(StringIO.new(pdf))
      expect(pdf_reader.pages.first.text).to include 'Streamed Content'
    end

    it 'allows multiple streaming sessions' do
      processor.stream_start({})
      processor.stream_append('<html><body><h1>First</h1></body></html>')
      pdf1 = processor.stream_finish

      processor.stream_start({})
      processor.stream_append('<html><body><h1>Second</h1></body></html>')
      pdf2 = processor.stream_finish

      expect(PDF::Reader.new(StringIO.new(pdf1)).pages.first.text).to include 'First'
      expect(PDF::Reader.new(StringIO.new(pdf2)).pages.first.text).to include 'Second'
    end

    it 'raises error when stream_start called twice' do
      processor.stream_start({})

      expect do
        processor.stream_start({})
      end.to raise_error Grover::Error, /Streaming session already active/
    end

    it 'raises error when stream_append called without stream_start' do
      expect do
        processor.stream_append('<html>')
      end.to raise_error Grover::Error, /No active streaming session/
    end

    it 'raises error when stream_finish called without stream_start' do
      expect do
        processor.stream_finish
      end.to raise_error Grover::Error, /No active streaming session/
    end
  end

  describe '.batch' do
    it 'yields a processor instance' do
      described_class.batch do |proc|
        expect(proc).to be_a described_class
      end
    end

    it 'allows generating multiple PDFs' do
      pdfs = []

      described_class.batch do |proc|
        pdfs << proc.convert(:pdf, '<html><body>Page 1</body></html>', {})
        pdfs << proc.convert(:pdf, '<html><body>Page 2</body></html>', {})
      end

      expect(pdfs.length).to eq 2
      expect(pdfs[0]).to start_with "%PDF-1.4\n"
      expect(pdfs[1]).to start_with "%PDF-1.4\n"
    end

    it 'shuts down the processor after the block' do
      captured_processor = nil

      described_class.batch do |proc|
        proc.convert(:pdf, '<html><body>Test</body></html>', {})
        captured_processor = proc
      end

      expect(captured_processor.alive?).to be false
    end

    it 'shuts down the processor even on exception' do
      captured_processor = nil

      expect do
        described_class.batch do |proc|
          captured_processor = proc
          proc.convert(:pdf, '<html><body>Test</body></html>', {})
          raise 'Test error'
        end
      end.to raise_error('Test error')

      expect(captured_processor.alive?).to be false
    end
  end

  describe 'Grover.batch' do
    it 'delegates to BatchProcessor.batch' do
      pdfs = []

      Grover.batch do |proc|
        pdfs << proc.convert(:pdf, '<html><body>Via Grover.batch</body></html>', {})
      end

      expect(pdfs.length).to eq 1
      expect(pdfs[0]).to start_with "%PDF-1.4\n"
      expect(PDF::Reader.new(StringIO.new(pdfs[0])).pages.first.text).to include 'Via Grover.batch'
    end
  end

  describe '#shutdown' do
    it 'cleans up the worker process' do
      processor.convert(:pdf, '<html><body>Test</body></html>', {})
      expect(processor.alive?).to be true

      processor.shutdown

      expect(processor.alive?).to be false
    end

    it 'can be called multiple times safely' do
      processor.convert(:pdf, '<html><body>Test</body></html>', {})

      expect { processor.shutdown }.not_to raise_error
      expect { processor.shutdown }.not_to raise_error
    end
  end

  describe '#alive?' do
    it 'returns false before any conversion' do
      expect(processor.alive?).to be false
    end

    it 'returns true after conversion' do
      processor.convert(:pdf, '<html><body>Test</body></html>', {})
      expect(processor.alive?).to be true
    end

    it 'returns false after shutdown' do
      processor.convert(:pdf, '<html><body>Test</body></html>', {})
      processor.shutdown
      expect(processor.alive?).to be false
    end
  end

  describe 'error handling' do
    context 'when passing through an invalid URL' do
      it 'raises a JavaScript error' do
        expect do
          processor.convert(:pdf, 'https://fake.invalid', {})
        end.to raise_error Grover::JavaScript::Error, /net::ERR_NAME_NOT_RESOLVED/
      end

      it 'can continue processing after an error' do
        expect do
          processor.convert(:pdf, 'https://fake.invalid', {})
        end.to raise_error Grover::JavaScript::Error

        pdf = processor.convert(:pdf, '<html><body>Recovery</body></html>', {})
        expect(pdf).to start_with "%PDF-1.4\n"
      end
    end
  end

  describe 'thread safety' do
    it 'handles concurrent access safely and preserves content integrity' do
      thread_count = 5
      threads = thread_count.times.map do |i|
        Thread.new(i) do |thread_id|
          html = "<html><body>UniqueContent#{thread_id}</body></html>"
          { thread_id: thread_id, pdf: processor.convert(:pdf, html, {}) }
        end
      end

      results = threads.map(&:value)

      expect(results.length).to eq thread_count
      expect(results.map { |r| r[:pdf] }).to all(start_with("%PDF-1.4\n"))

      # Verify each PDF contains the correct content for its thread
      results.each do |result|
        pdf_reader = PDF::Reader.new(StringIO.new(result[:pdf]))
        pdf_text = pdf_reader.pages.first.text
        expect(pdf_text).to include("UniqueContent#{result[:thread_id]}")
      end
    end
  end

  describe 'with options' do
    let(:url_or_html) { '<html><head><title>Test Page</title></head><body><h1>Options Test</h1></body></html>' }

    context 'when passing format option' do
      it 'respects the A4 format option' do
        pdf = processor.convert(:pdf, url_or_html, { 'format' => 'A4' })
        pdf_reader = PDF::Reader.new(StringIO.new(pdf))

        # A4 dimensions are approximately 595 x 842 points
        media_box = pdf_reader.pages.first.attributes[:MediaBox]
        expect(media_box[2]).to be_within(5).of(595)
        expect(media_box[3]).to be_within(5).of(842)
      end
    end
  end

  context 'when using remote browser', :remote_browser do
    let(:options) { { 'browserWsEndpoint' => 'ws://localhost:3000/' } }
    let(:url_or_html) { '<html><body style="background-color: blue">Remote browser works!</body></html>' }

    it 'connects to remote browser' do
      pdf = processor.convert(:pdf, url_or_html, options)

      expect(pdf).to start_with "%PDF-1.4\n"

      pdf_reader = PDF::Reader.new(StringIO.new(pdf))
      expect(pdf_reader.pages.first.text).to include 'Remote browser works!'
    end

    it 'reuses the remote browser connection' do
      pdf1 = processor.convert(:pdf, '<html><body>First</body></html>', options)
      pdf2 = processor.convert(:pdf, '<html><body>Second</body></html>', options)

      expect(pdf1).to start_with "%PDF-1.4\n"
      expect(pdf2).to start_with "%PDF-1.4\n"
    end
  end
end
