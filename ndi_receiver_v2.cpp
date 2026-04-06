#include <iostream>
#include <string>
#include <cstring>
#include <thread>
#include <chrono>
#include <signal.h>
#include <cstdlib>
#include <gst/gst.h>
#include <gst/app/gstappsrc.h>
#include <Processing.NDI.Lib.h>

class NDIReceiver {
private:
    NDIlib_recv_instance_t ndi_recv = nullptr;

    GstElement *pipeline = nullptr;
    GstElement *appsrc = nullptr;
    GstElement *audio_appsrc = nullptr;
    GMainLoop *main_loop = nullptr;

    std::string current_source;

    bool is_running = false;
    bool first_frame_logged = false;

    int source_width = 0;
    int source_height = 0;
    double frame_rate = 0.0;
    
    // Default to 4K
    int display_width = 3840;
    int display_height = 2160;

    std::string display_name = "Generic Display";
    bool pipeline_created = false;

    int actual_frame_width = 0;
    int actual_frame_height = 0;
    int actual_frame_rate_n = 0;
    int actual_frame_rate_d = 1;
    
    // Multiple methods to detect display resolution
    void detectDisplayResolution() {
        
        /**
         * Method 1:
         * wlr-randr for Wayland
         * Get display model name and resolution
         */
        FILE* namePipe = popen("wlr-randr 2>/dev/null | grep 'Model:' | head -1 | sed 's/.*Model: //'", "r");
        if (namePipe) {
            char nameBuffer[256];
            if (fgets(nameBuffer, sizeof(nameBuffer), namePipe)) {
                nameBuffer[strcspn(nameBuffer, "\n")] = 0; // >>>> Remove trailing newline
                if (strlen(nameBuffer) > 0) {
                    display_name = nameBuffer;
                }
            }
            pclose(namePipe);
        }
        /**
         * Resolution
         * wlr-randr
         * look for 'current'
         */
        FILE* pipe = popen("wlr-randr 2>/dev/null | grep current | grep -oE '[0-9]+x[0-9]+' | head -1", "r");
        if (pipe) {
            char buffer[128];
            if (fgets(buffer, sizeof(buffer), pipe)) {
                int w, h;
                if (sscanf(buffer, "%dx%d", &w, &h) == 2 && w > 100 && h > 100) {
                    display_width = w;
                    display_height = h;
                    pclose(pipe);
                    std::cout << "Display: " << display_width << "x" << display_height << " (wlr-randr)" << std::endl;
                    std::cout << "Monitor: " << display_name << std::endl;
                    return;
                }
            }
            pclose(pipe);
        }
        
        /**
         * Method 2:
         * fbset for framebuffer
         */
        pipe = popen("fbset 2>/dev/null | grep geometry | awk '{print $2 \"x\" $3}'", "r");
        if (pipe) {
            char buffer[128];
            if (fgets(buffer, sizeof(buffer), pipe)) {
                int w, h;
                if (sscanf(buffer, "%dx%d", &w, &h) == 2 && w > 100 && h > 100) {
                    display_width = w;
                    display_height = h;
                    pclose(pipe);
                    std::cout << "Display: " << display_width << "x" << display_height << " (fbset)" << std::endl;
                    return;
                }
            }
            pclose(pipe);
        }
        
        /**
         * Method 3:
         * use '/sys/class/drm' for HDMI
         */
        pipe = popen("cat /sys/class/drm/card?-HDMI-A-1/modes 2>/dev/null | head -1", "r");
        if (pipe) {
            char buffer[128];
            if (fgets(buffer, sizeof(buffer), pipe)) {
                int w, h;
                if (sscanf(buffer, "%dx%d", &w, &h) == 2 && w > 100 && h > 100) {
                    display_width = w;
                    display_height = h;
                    pclose(pipe);
                    std::cout << "Display: " << display_width << "x" << display_height << " (drm)" << std::endl;
                    return;
                }
            }
            pclose(pipe);
        }
        
        /**
         * Method 4:
         * Check environment variable 'DISPLAY_RESOLUTION'
         * Format: Wd.xHt. (e.g. 1920x1080)
         */
        const char* res = getenv("DISPLAY_RESOLUTION");
        if (res) {
            int w, h;
            if (sscanf(res, "%dx%d", &w, &h) == 2 && w > 100 && h > 100) {
                display_width = w;
                display_height = h;
                std::cout << "Display: " << display_width << "x" << display_height << " (env)" << std::endl;
                return;
            }
        }
        
        /**
         * Fallback:
         * 4K for last resort
         * Maybe change to 2K (2560x1440) if compatibility issues occur frequently
         */
        display_width = 3840;
        display_height = 2160;
        std::cout << "Display: " << display_width << "x" << display_height << " (default 4K)" << std::endl;
    }
    
public:
    NDIReceiver() {
        // Initialize GStreamer
        gst_init(nullptr, nullptr);
        
        // Initialize member variables
        pipeline = nullptr;
        appsrc = nullptr;
        audio_appsrc = nullptr;
        main_loop = nullptr;
        ndi_recv = nullptr;
        
        // Detect display resolution
        detectDisplayResolution();
        
        // Initialize NDI
        if (!NDIlib_initialize()) {
            throw std::runtime_error("Failed to initialize NDI");
        }
        
        // Create NDI receiver with v3 struct - LOW LATENCY MODE
        NDIlib_recv_create_v3_t recv_desc;
        recv_desc.source_to_connect_to.p_ndi_name = nullptr;
        recv_desc.source_to_connect_to.p_url_address = nullptr;
        recv_desc.color_format = NDIlib_recv_color_format_UYVY_RGBA;
        recv_desc.bandwidth = NDIlib_recv_bandwidth_highest;
        recv_desc.allow_video_fields = false;  // Disable interlaced - reduces latency
        recv_desc.p_ndi_recv_name = "NDPi-Monitor-Client";
        
        ndi_recv = NDIlib_recv_create_v3(&recv_desc);
        if (!ndi_recv) {
            throw std::runtime_error("Failed to create NDI receiver");
        }
        
        main_loop = g_main_loop_new(nullptr, FALSE);
    }
    
    ~NDIReceiver() {
        stop();
        if (ndi_recv) NDIlib_recv_destroy(ndi_recv);
        if (main_loop) g_main_loop_unref(main_loop);
        NDIlib_destroy();
    }
    
    bool connectToSource(const std::string& source_name) {
        if (source_name == "None" || source_name.empty()) {
            stop();
            return true;
        }
        
        // Find the source using v2 struct
        NDIlib_find_create_t find_desc;
        find_desc.show_local_sources = true;
        find_desc.p_groups = nullptr;
        find_desc.p_extra_ips = nullptr;
        
        NDIlib_find_instance_t finder = NDIlib_find_create_v2(&find_desc);
        if (!finder) {
            std::cerr << "Failed to create NDI finder" << std::endl;
            return false;
        }
        
        uint32_t num_sources = 0;
        const NDIlib_source_t* sources = nullptr;
        
        std::cout << "Searching for NDI sources (15 second timeout)..." << std::endl;
        
        // Wait up to 15 seconds for sources
        auto start_time = std::chrono::high_resolution_clock::now();
        while ((std::chrono::high_resolution_clock::now() - start_time) < std::chrono::seconds(15)) {
            NDIlib_find_wait_for_sources(finder, 1000);
            sources = NDIlib_find_get_current_sources(finder, &num_sources);
            
            if (num_sources > 0) {
                std::cout << "Found " << num_sources << " NDI sources:" << std::endl;
                for (uint32_t i = 0; i < num_sources; i++) {
                    std::cout << "  [" << i << "] " << sources[i].p_ndi_name << std::endl;
                }
            }
            
            // Check if we found our target
            for (uint32_t i = 0; i < num_sources; i++) {
                if (source_name == sources[i].p_ndi_name) {
                    std::cout << "Found target source: " << source_name << std::endl;
                    // Connect to source
                    NDIlib_recv_connect(ndi_recv, &sources[i]);
                    current_source = source_name;
                    NDIlib_find_destroy(finder);
                    return true;
                }
            }
        }
        
        std::cerr << "Source not found after 15 seconds. Available sources:" << std::endl;
        for (uint32_t i = 0; i < num_sources; i++) {
            std::cerr << "  - " << sources[i].p_ndi_name << std::endl;
        }
        
        NDIlib_find_destroy(finder);
        return false;
    }
    
    void createPipeline(int width, int height, int framerate_n, int framerate_d) {
        // Check if pipeline needs to be recreated (resolution or framerate changed)
        if (pipeline_created && 
            width == actual_frame_width && 
            height == actual_frame_height &&
            framerate_n == actual_frame_rate_n &&
            framerate_d == actual_frame_rate_d) {
            return; // Pipeline already matches
        }
        
        // Stop and destroy existing pipeline
        if (pipeline) {
            gst_element_set_state(pipeline, GST_STATE_NULL);
            // Wait for state change to complete
            gst_element_get_state(pipeline, NULL, NULL, GST_CLOCK_TIME_NONE);
            gst_object_unref(pipeline);
            pipeline = nullptr;
            pipeline_created = false;
        }
        // Release audio_appsrc if it exists
        if (audio_appsrc) {
            gst_object_unref(audio_appsrc);
            audio_appsrc = nullptr;
        }
        
        actual_frame_width = width;
        actual_frame_height = height;
        actual_frame_rate_n = framerate_n;
        actual_frame_rate_d = framerate_d;
        
        double fps = (double)framerate_n / (double)framerate_d;
        
        // Log the format change
        std::cout << "Video: " << width << "x" << height << " @ " << fps << " fps" << std::endl;
        std::cout << "Display: " << display_width << "x" << display_height << std::endl;
        std::flush(std::cout);
        
        // Create GStreamer pipeline with autovideosink - OPTIMIZED FOR LOW LATENCY
        // - queue max-size-buffers=1: minimal buffering
        // - leaky=downstream: drop frames if backed up rather than buffering
        // - sync=false: don't wait for clock sync
        char pipeline_str[1024];
        snprintf(pipeline_str, sizeof(pipeline_str),
            "appsrc name=ndi_src format=time is-live=true do-timestamp=true max-latency=0 "
            "caps=video/x-raw,format=UYVY,width=%d,height=%d,framerate=%d/%d ! "
            "queue max-size-buffers=1 max-size-time=0 max-size-bytes=0 leaky=downstream ! "
            "videoconvert ! "
            "videoscale method=bilinear add-borders=false ! "
            "video/x-raw,width=%d,height=%d ! "
            "autovideosink sync=false "
            "appsrc name=audio_src format=time is-live=true do-timestamp=true "
            "caps=audio/x-raw,format=S16LE,channels=2,rate=48000,layout=interleaved ! "
            "queue ! audioconvert ! audioresample ! autoaudiosink",
            width, height, framerate_n, framerate_d,
            display_width, display_height);
            
        GError *error = nullptr;
        pipeline = gst_parse_launch(pipeline_str, &error);
        
        if (error) {
            std::cerr << "Pipeline error: " << error->message << std::endl;
            g_error_free(error);
            return;
        }
        
        pipeline_created = true;
        
        /**
         * Get audio element 
         * then
         * Start GStreamer pipeline
         * 
         */ 
        audio_appsrc = gst_bin_get_by_name(GST_BIN(pipeline), "audio_src");
        gst_element_set_state(pipeline, GST_STATE_PLAYING);
        
        std::cout << "Source: " << width << "x" << height << " @ " 
                  << ((double)framerate_n / framerate_d) << " fps" << std::endl;
        std::cout << "Resolution Scaled: " << display_width << "x" << display_height << std::endl;
    }
    
    void start() {
        if (is_running) return;
        is_running = true;
        first_frame_logged = false;
        pipeline_created = false;
        
        // Start NDI receiving thread (will create pipeline when first frame arrives)
        std::thread(&NDIReceiver::receiveLoop, this).detach();
        
        std::cout << "NDI Receiver started: " << current_source << std::endl;
    }
    
    void stop() {
        if (!is_running) return;
        is_running = false;
        
        if (pipeline) {
            gst_element_set_state(pipeline, GST_STATE_NULL);
            gst_object_unref(pipeline);
            pipeline = nullptr;
        }
        // Release audio_appsrc if it exists
        if (audio_appsrc) {
            gst_object_unref(audio_appsrc);
            audio_appsrc = nullptr;
        }
        pipeline_created = false;
        
        std::cout << "NDI Receiver stopped" << std::endl;
    }
    
private:
    void receiveLoop() {
        NDIlib_video_frame_v2_t video_frame;
        NDIlib_audio_frame_v2_t audio_frame;
        GstElement* appsrc = nullptr;
        
        while (is_running) {
            switch (NDIlib_recv_capture_v2(ndi_recv, &video_frame, &audio_frame, nullptr, 100)) {
                case NDIlib_frame_type_video: {
                    // Check if pipeline needs to be created or recreated
                    // (resolution or framerate changed)
                    bool needs_pipeline_update = !pipeline_created || 
                        video_frame.xres != actual_frame_width || 
                        video_frame.yres != actual_frame_height ||
                        video_frame.frame_rate_N != actual_frame_rate_n ||
                        video_frame.frame_rate_D != actual_frame_rate_d;
                    
                    if (needs_pipeline_update) {
                        // Release old appsrc reference
                        if (appsrc) {
                            gst_object_unref(appsrc);
                            appsrc = nullptr;
                        }
                        
                        createPipeline(video_frame.xres, video_frame.yres, 
                                      video_frame.frame_rate_N, video_frame.frame_rate_D);
                        
                        if (pipeline) {
                            appsrc = gst_bin_get_by_name(GST_BIN(pipeline), "ndi_src");
                        }
                        
                        // Update stored values
                        source_width = video_frame.xres;
                        source_height = video_frame.yres;
                        frame_rate = (double)video_frame.frame_rate_N / (double)video_frame.frame_rate_D;
                        
                        if (!first_frame_logged) {
                            std::cout << "Connected to: " << current_source << std::endl;
                            first_frame_logged = true;
                        }
                    }
                    
                    if (appsrc) {
                        // Create GStreamer buffer from NDI frame
                        gsize frame_size = video_frame.yres * video_frame.line_stride_in_bytes;
                        GstBuffer *buffer = gst_buffer_new_allocate(nullptr, frame_size, nullptr);
                        
                        GstMapInfo map;
                        gst_buffer_map(buffer, &map, GST_MAP_WRITE);
                        memcpy(map.data, video_frame.p_data, frame_size);
                        gst_buffer_unmap(buffer, &map);
                        
                        // Push to pipeline
                        GstFlowReturn ret;
                        g_signal_emit_by_name(appsrc, "push-buffer", buffer, &ret);
                        gst_buffer_unref(buffer);
                    }
                    
                    NDIlib_recv_free_video_v2(ndi_recv, &video_frame);
                    break;
                }
                case NDIlib_frame_type_audio: {
                    if (audio_appsrc) {
                        // NDI audio is 32-bit float PLANAR — must convert to 16-bit INTERLEAVED
                        // to match GStreamer caps (S16LE, layout=interleaved).
                        // Raw memcpy of float planar data into an S16LE buffer = white noise.
                        NDIlib_audio_frame_interleaved_16s_t audio_16s;
                        audio_16s.sample_rate = audio_frame.sample_rate;
                        audio_16s.no_channels = audio_frame.no_channels;
                        audio_16s.no_samples = audio_frame.no_samples;
                        audio_16s.timecode = audio_frame.timecode;
                        audio_16s.reference_level = 0;

                        gsize buffer_size = audio_frame.no_samples * audio_frame.no_channels * sizeof(short);
                        audio_16s.p_data = (short*)malloc(buffer_size);

                        // NDI SDK utility: float planar → interleaved 16-bit PCM
                        NDIlib_util_audio_to_interleaved_16s_v2(&audio_frame, &audio_16s);

                        // Create GStreamer buffer from converted data
                        GstBuffer *buffer = gst_buffer_new_allocate(nullptr, buffer_size, nullptr);
                        GstMapInfo map;
                        gst_buffer_map(buffer, &map, GST_MAP_WRITE);
                        memcpy(map.data, audio_16s.p_data, buffer_size);
                        gst_buffer_unmap(buffer, &map);

                        free(audio_16s.p_data);

                        // Push buffer to pipeline
                        GstFlowReturn ret;
                        g_signal_emit_by_name(audio_appsrc, "push-buffer", buffer, &ret);
                        gst_buffer_unref(buffer);
                    }

                    NDIlib_recv_free_audio_v2(ndi_recv, &audio_frame);
                    break;
                }
                case NDIlib_frame_type_none:
                    // No data, continue
                    break;
            }
        }
        
        if (appsrc) {
            gst_object_unref(appsrc);
        }
    }
};

// Global receiver instance
NDIReceiver* g_receiver = nullptr;

void signalHandler(int sig) {
    std::cout << "\nShutting down..." << std::endl;
    if (g_receiver) {
        g_receiver->stop();
        delete g_receiver;
        g_receiver = nullptr;
    }
    exit(0);
}

int main(int argc, char* argv[]) {
    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);
    
    try {
        g_receiver = new NDIReceiver();
        
        if (argc > 1) {
            std::string source_name = argv[1];
            std::cout << "Connecting to source: " << source_name << std::endl;
            
            if (g_receiver->connectToSource(source_name)) {
                g_receiver->start();
                
                // Keep running
                while (true) {
                    std::this_thread::sleep_for(std::chrono::milliseconds(100));
                }
            } else {
                std::cerr << "Failed to connect to source: " << source_name << std::endl;
                return 1;
            }
        } else {
            std::cout << "NDI Receiver ready (no source specified)" << std::endl;
            // Keep running for commands
            while (true) {
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            }
        }
    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << std::endl;
        return 1;
    }
    
    return 0;
}