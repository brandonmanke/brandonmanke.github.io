/**
 * script.js
 * modernizr checks & preloading
 */

// image preloading for lazy loading of background
function preloadImage(url, callback) {
    var img = new Image();
    img.src = url;
    img.onload = callback;
}

window.onload = function() {
    //document.body.style.backgroundImage = 'url(./assets/images/anthony-delanoix.jpg)';
    preloadImage('./assets/images/anthony-delanoix.jpg', function() {
        document.body.style.backgroundImage = 'url(./assets/images/anthony-delanoix.jpg)';
        setTimeout(function() {
            document.getElementById('bg-image').style.display = 'none';
        }, 50);
    });

    if (Modernizr.svg) {
        console.log('svg');
    } else {
        var mail = document.getElementById('mail');
        var github = document.getElementById('github');
        var linkedin = document.getElementById('linkedin');
        var stackoverflow = document.getElementById('stackoverflow');
        var location = document.getElementById('location');

        mail.src = 'assets/images/' + mail + '.png';
        github.src = 'assets/images/' + github + '.png';
        linkedin.src = 'assets/images/' + linkedin + '.png';
        stackoverflow.src = 'assets/images/' + stackoverflow + '.png';
        location.src = 'assets/images/' + location + '.png';
    }
}